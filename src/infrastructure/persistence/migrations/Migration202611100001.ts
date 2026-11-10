import { Migration } from '@mikro-orm/migrations';

/** Hand-authored: schema generation cannot replace the deferred financial constraints. */
export class Migration202611100001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION wagering_valid_money(value numeric) RETURNS boolean
      LANGUAGE sql IMMUTABLE STRICT AS $$
        SELECT value::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND abs(value) < 1e36::numeric AND scale(value) <= 2
      $$;

      CREATE TABLE wallets (
        id text PRIMARY KEY CHECK (btrim(id) <> ''),
        player_id text NOT NULL CHECK (btrim(player_id) <> ''),
        currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric NOT NULL CHECK (wagering_valid_money(balance) AND balance >= 0),
        version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
        created_at timestamptz(3) NOT NULL,
        updated_at timestamptz(3) NOT NULL CHECK (updated_at >= created_at),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_identity_unique UNIQUE (id, player_id, currency)
      );

      CREATE TABLE wager_transactions (
        id text PRIMARY KEY CHECK (btrim(id) <> ''),
        provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
        external_transaction_id text NOT NULL CHECK (btrim(external_transaction_id) <> ''),
        idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
        payload_hash text NOT NULL CHECK (btrim(payload_hash) <> ''),
        wallet_id text NOT NULL,
        player_id text NOT NULL,
        round_id text NOT NULL CHECK (btrim(round_id) <> ''),
        game_id text NOT NULL CHECK (btrim(game_id) <> ''),
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric NOT NULL CHECK (wagering_valid_money(amount)),
        currency text NOT NULL,
        reference_external_transaction_id text CHECK (btrim(reference_external_transaction_id) <> ''),
        reference_transaction_id text,
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text CHECK (failure_code IN ('INVALID_MONEY','CURRENCY_MISMATCH','INVALID_PAYLOAD',
          'INSUFFICIENT_FUNDS','REVERSAL_INSUFFICIENT_FUNDS','INVALID_STATE','INVALID_REFERENCE',
          'REFERENCE_NOT_FOUND','ALREADY_REVERSED','IDEMPOTENCY_CONFLICT','INVALID_LEDGER','PERMANENT_INFRASTRUCTURE_FAILURE')),
        created_at timestamptz(3) NOT NULL,
        processed_at timestamptz(3) CHECK (processed_at >= created_at),
        CONSTRAINT wagers_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wagers_provider_idempotency_unique UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wagers_wallet_fk FOREIGN KEY (wallet_id, player_id, currency)
          REFERENCES wallets (id, player_id, currency) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT wagers_reference_fk FOREIGN KEY (reference_transaction_id)
          REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT wagers_amount_check CHECK ((kind = 'LOSS' AND amount = 0) OR (kind <> 'LOSS' AND amount > 0)),
        CONSTRAINT wagers_reference_check CHECK (
          (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)
          AND (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL)
          AND (reference_external_transaction_id IS NULL OR reference_external_transaction_id <> external_transaction_id)
          AND (reference_transaction_id IS NULL OR reference_transaction_id <> id)
          AND (status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL)
          AND ((status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL) = (reference_transaction_id IS NOT NULL))
        ),
        CONSTRAINT wagers_terminal_metadata_check CHECK (
          (status = 'PROCESSED') = (processed_at IS NOT NULL)
          AND (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX wagers_processed_reversal_unique
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE UNIQUE INDEX wagers_opening_unique ON wager_transactions (wallet_id)
        WHERE kind = 'OPENING' AND status = 'PROCESSED';
      CREATE INDEX wagers_pending_reference_idx ON wager_transactions
        (provider_id, reference_external_transaction_id, created_at, id) WHERE status = 'PENDING_REFERENCE';
      CREATE INDEX wagers_wallet_idx ON wager_transactions (wallet_id, created_at, id);
      CREATE INDEX wagers_reference_idx ON wager_transactions (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL;

      CREATE TABLE wallet_ledger_entries (
        id text PRIMARY KEY CHECK (btrim(id) <> ''),
        wallet_id text NOT NULL REFERENCES wallets (id) DEFERRABLE INITIALLY DEFERRED,
        transaction_id text NOT NULL REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        wallet_version bigint NOT NULL CHECK (wallet_version BETWEEN 1 AND 9007199254740991),
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric NOT NULL CHECK (wagering_valid_money(amount) AND amount > 0),
        currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_before numeric NOT NULL CHECK (wagering_valid_money(balance_before) AND balance_before >= 0),
        balance_after numeric NOT NULL CHECK (wagering_valid_money(balance_after) AND balance_after >= 0),
        created_at timestamptz(3) NOT NULL,
        CONSTRAINT ledger_wallet_transaction_unique UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_wallet_version_unique UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_arithmetic_check CHECK (balance_after = balance_before +
          CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE INDEX ledger_transaction_idx ON wallet_ledger_entries (transaction_id);

      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL CHECK (btrim(consumer_name) <> ''),
        message_id text NOT NULL CHECK (btrim(message_id) <> ''),
        payload_hash text NOT NULL CHECK (btrim(payload_hash) <> ''),
        received_at timestamptz(3) NOT NULL,
        processed_at timestamptz(3) CHECK (processed_at >= received_at),
        PRIMARY KEY (consumer_name, message_id)
      );
      CREATE INDEX inbox_pending_idx ON inbox_messages (consumer_name, received_at, message_id)
        WHERE processed_at IS NULL;
      CREATE TABLE outbox_messages (
        id text PRIMARY KEY CHECK (btrim(id) <> ''),
        aggregate_id text NOT NULL CHECK (btrim(aggregate_id) <> ''),
        event_type text NOT NULL CHECK (btrim(event_type) <> ''),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        occurred_at timestamptz(3) NOT NULL,
        attempts bigint NOT NULL CHECK (attempts BETWEEN 0 AND 9007199254740991),
        next_attempt_at timestamptz(3) CHECK (next_attempt_at >= occurred_at),
        published_at timestamptz(3) CHECK (published_at >= occurred_at),
        CHECK (published_at IS NULL OR next_attempt_at IS NULL),
        CHECK (attempts > 0 OR next_attempt_at IS NULL)
      );
      CREATE INDEX outbox_due_idx ON outbox_messages (coalesce(next_attempt_at, occurred_at), id)
        WHERE published_at IS NULL;
      CREATE INDEX outbox_aggregate_idx ON outbox_messages (aggregate_id, occurred_at, id);

      CREATE FUNCTION wagering_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Financial history cannot be updated, deleted or truncated' USING ERRCODE = '23514';
      END $$;
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wagering_forbid_mutation();
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wagering_forbid_mutation();
      CREATE TRIGGER wagers_no_delete BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wagering_forbid_mutation();
      CREATE TRIGGER wagers_no_truncate BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION wagering_forbid_mutation();
      CREATE TRIGGER wallets_no_delete BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wagering_forbid_mutation();
      CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON wallets
        FOR EACH STATEMENT EXECUTE FUNCTION wagering_forbid_mutation();

      CREATE FUNCTION wagering_guard_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM
           (OLD.id, OLD.player_id, OLD.currency, OLD.created_at)
           OR NEW.version < OLD.version OR NEW.updated_at < OLD.updated_at
           OR (NEW.balance <> OLD.balance AND NEW.version <= OLD.version) THEN
          RAISE EXCEPTION 'Invalid wallet identity/version update' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER wallets_guard BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wagering_guard_wallet();

      CREATE FUNCTION wagering_guard_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') OR
          (to_jsonb(NEW) - ARRAY['status','reference_transaction_id','failure_code','processed_at']) IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status','reference_transaction_id','failure_code','processed_at']) OR
          (OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING') THEN
          RAISE EXCEPTION 'Immutable transaction payload or terminal state' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER wagers_guard BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wagering_guard_transaction();

      CREATE FUNCTION wagering_guard_message() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'inbox_messages' THEN
          IF OLD.processed_at IS NOT NULL OR
            (to_jsonb(NEW) - 'processed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'processed_at') THEN
            RAISE EXCEPTION 'Immutable inbox identity or processed message' USING ERRCODE = '23514';
          END IF;
        ELSE
          IF OLD.published_at IS NOT NULL OR NEW.attempts < OLD.attempts OR
            (to_jsonb(NEW) - ARRAY['attempts','next_attempt_at','published_at']) IS DISTINCT FROM
            (to_jsonb(OLD) - ARRAY['attempts','next_attempt_at','published_at']) THEN
            RAISE EXCEPTION 'Immutable outbox event or published message' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER inbox_guard BEFORE UPDATE ON inbox_messages
        FOR EACH ROW EXECUTE FUNCTION wagering_guard_message();
      CREATE TRIGGER outbox_guard BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION wagering_guard_message();

      -- Serializes direct ledger inserts as well as repository writes on this wallet only.
      CREATE FUNCTION wagering_lock_ledger_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM wallets WHERE id = NEW.wallet_id FOR UPDATE;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ledger_lock_wallet BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wagering_lock_ledger_wallet();

      -- Check the final head at COMMIT, after all repositories have flushed in any order.
      CREATE FUNCTION wagering_check_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE w wallets%ROWTYPE; head wallet_ledger_entries%ROWTYPE; target_id text;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN target_id := NEW.id; ELSE target_id := NEW.wallet_id; END IF;
        SELECT * INTO STRICT w FROM wallets WHERE id = target_id;
        SELECT * INTO head FROM wallet_ledger_entries WHERE wallet_id = target_id ORDER BY wallet_version DESC LIMIT 1;
        IF NOT FOUND THEN
          IF w.balance <> 0 OR w.version <> 1 THEN
            RAISE EXCEPTION 'Wallet requires ledger history' USING ERRCODE = '23514';
          END IF;
        ELSIF w.balance <> head.balance_after OR w.version <> head.wallet_version OR w.updated_at <> head.created_at THEN
          RAISE EXCEPTION 'Wallet balance/version differs from ledger head' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering_check_wallet();
      CREATE CONSTRAINT TRIGGER ledger_wallet_consistency AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering_check_wallet();

      CREATE FUNCTION wagering_check_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE tx wager_transactions%ROWTYPE; ref wager_transactions%ROWTYPE;
        prev wallet_ledger_entries%ROWTYPE; w wallets%ROWTYPE; expected_direction text;
      BEGIN
        SELECT * INTO STRICT tx FROM wager_transactions WHERE id = NEW.transaction_id;
        SELECT * INTO STRICT w FROM wallets WHERE id = NEW.wallet_id;
        IF tx.status <> 'PROCESSED' OR tx.kind = 'LOSS' OR tx.wallet_id <> NEW.wallet_id
          OR tx.currency <> NEW.currency OR tx.amount <> NEW.amount OR NEW.created_at < w.created_at
          OR NEW.created_at <> tx.processed_at THEN
          RAISE EXCEPTION 'Ledger does not match processed financial transaction' USING ERRCODE = '23514';
        END IF;
        SELECT * INTO ref FROM wager_transactions WHERE id = tx.reference_transaction_id;
        expected_direction := CASE WHEN tx.kind = 'BET' OR
          (tx.kind = 'ROLLBACK' AND ref.kind <> 'BET') THEN 'DEBIT' ELSE 'CREDIT' END;
        IF NEW.direction <> expected_direction THEN
          RAISE EXCEPTION 'Ledger direction differs from transaction' USING ERRCODE = '23514';
        END IF;
        IF tx.kind = 'OPENING' THEN
          IF NEW.wallet_version <> 1 OR NEW.balance_before <> 0 OR NEW.created_at <> w.created_at THEN
            RAISE EXCEPTION 'Opening must be the first ledger entry' USING ERRCODE = '23514';
          END IF;
        ELSE
          SELECT * INTO prev FROM wallet_ledger_entries
            WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
          IF NEW.wallet_version < 2 OR
            (NOT FOUND AND (NEW.wallet_version <> 2 OR NEW.balance_before <> 0)) OR
            (FOUND AND (NEW.balance_before <> prev.balance_after OR NEW.created_at < prev.created_at)) THEN
            RAISE EXCEPTION 'Ledger chain is discontinuous' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER ledger_transaction_consistency AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering_check_ledger();

      CREATE FUNCTION wagering_check_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE tx wager_transactions%ROWTYPE; ref wager_transactions%ROWTYPE; has_entry boolean;
      BEGIN
        SELECT * INTO STRICT tx FROM wager_transactions WHERE id = NEW.id;
        SELECT EXISTS(SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = tx.wallet_id AND transaction_id = tx.id) INTO has_entry;
        IF (tx.status = 'PROCESSED' AND tx.kind <> 'LOSS') <> has_entry THEN
          RAISE EXCEPTION 'Processed financial transaction requires exactly one ledger entry' USING ERRCODE = '23514';
        END IF;
        IF tx.reference_transaction_id IS NOT NULL THEN
          SELECT * INTO STRICT ref FROM wager_transactions WHERE id = tx.reference_transaction_id;
          IF ref.status <> 'PROCESSED' OR
            (ref.provider_id, ref.player_id, ref.wallet_id, ref.currency, ref.round_id, ref.external_transaction_id) IS DISTINCT FROM
            (tx.provider_id, tx.player_id, tx.wallet_id, tx.currency, tx.round_id, tx.reference_external_transaction_id) OR
            (tx.kind = 'ROLLBACK' AND ref.kind NOT IN ('BET','WIN','REFUND')) OR
            (tx.kind <> 'ROLLBACK' AND ref.kind <> 'BET') OR
            (tx.kind IN ('REFUND','ROLLBACK') AND tx.amount <> ref.amount) THEN
            RAISE EXCEPTION 'Invalid processed reference' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wagers_ledger_consistency AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering_check_transaction();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets;
      DROP FUNCTION wagering_check_transaction(), wagering_check_ledger(), wagering_check_wallet(),
        wagering_lock_ledger_wallet(), wagering_guard_message(), wagering_guard_transaction(),
        wagering_guard_wallet(), wagering_forbid_mutation(), wagering_valid_money(numeric);
    `);
  }
}
