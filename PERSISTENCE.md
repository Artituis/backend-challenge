# Persistência — Fase 2

A Fase 3 estende esta infraestrutura com locks transacionais de identidade,
respostas originais imutáveis e classificação de erros recuperáveis. Consulte
[WAGERING.md](WAGERING.md) para o fluxo completo dos casos de uso.

MikroORM 6.6, PostgreSQL 17 e Bun. O domínio continua sem dependências de
infraestrutura. `EntitySchema` mapeia snapshots próprios; os adapters chamam
exclusivamente `rehydrate` para reconstruir agregados, sem executar transições.

## Executar com Docker Compose

```sh
cp .env.example .env
docker compose up -d --wait postgres
docker compose run --build --rm migrate
```

No PowerShell, use `Copy-Item .env.example .env`. O banco fica em
`localhost:5432`; altere `POSTGRES_PORT` e `DATABASE_URL` juntos se necessário.
As credenciais de exemplo destinam-se ao ambiente local. O volume
`postgres_data` preserva os dados entre reinicializações.

```sh
# Histórico pendente e rollback da última migration
docker compose run --rm migrate bun run db:pending
docker compose run --rm migrate bun run db:rollback
docker compose run --rm migrate bun run db:migrate

# Typecheck + domínio + integração em PostgreSQL separado, sem porta exposta
docker compose --profile test run --build --rm test
docker compose --profile test stop postgres-test
```

O rollback da migration inicial remove as cinco tabelas e seus dados. Use-o
apenas quando a reversão do schema for intencional. Migrations não executam no
bootstrap de cada réplica: execute o serviço `migrate` uma vez antes do rollout.

Para executar no host:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run db:migrate
bun test
```

Bun carrega `.env`. A suíte de integração só roda quando `TEST_DATABASE_URL`
estiver definida; exige um banco cujo nome termine em `_test`. Cria um schema
aleatório, executa `up → down → up` e remove apenas esse schema ao terminar.
No Compose, esse banco é criado automaticamente pelo serviço `postgres-test`.
Sem a variável, `bun test` executa o domínio e sinaliza a integração como skipped.

## Organização

- `src/application/ports/persistence.ts`: contratos de repositórios e `UnitOfWork`.
- `src/infrastructure/persistence/entities.ts`: os cinco mapeamentos relacionais.
- `mappers.ts`: conversões de Money, datas, snapshots e `null` SQL para opcionais.
- `repositories.ts`: adapters com controle de escopo e locks por registro.
- `unit-of-work.ts`: `fork()` independente e `EntityManager.transactional()`.
- `migrations/Migration202611100001.ts`: schema completo e rollback versionado.
- `persistence.module.ts`: providers NestJS e encerramento do pool.

IDs permanecem `text`: o domínio aceita identificadores opacos, não apenas UUIDs.
Datas usam `timestamptz(3)`, alinhado à resolução de `Date`. Contadores são `bigint`
SQL, limitados a `Number.MAX_SAFE_INTEGER` e convertidos explicitamente para
`number`; essa conversão nunca é aplicada a valores monetários.

## Money e integridade SQL

Valor e moeda ocupam colunas separadas. O driver e `DecimalStringType` preservam
strings; `Money.from` normaliza a leitura para duas casas. A capacidade é de 36
dígitos inteiros e até 2 decimais. O adapter rejeita valores fora desse limite.

O SQL usa `numeric` sem escala coerciva, com `CHECK` de escala, magnitude e
finitude. Assim, `1.001`, `1.000`, `NaN`, infinitos e overflow são rejeitados, em
vez de arredondados. A normalização lexical do contrato continua no domínio:
PostgreSQL interpreta literais antes das constraints, portanto grafias como
notação científica não podem ser distinguidas depois de convertidas para numeric.

As migrations são a fonte de verdade do schema. Não execute `schema:update` ou
`schema:fresh`: metadados ORM não representam todos os triggers e constraints
compostas desta implementação. Nova mudança de schema deve ter migration
revisada, com `up` e `down`; registre sua classe em `migrationsList`.

Garantias implementadas no banco:

| Invariante | Proteção |
| --- | --- |
| Uma wallet por player/moeda | `UNIQUE (player_id, currency)` |
| Idempotência e identidade externa por provider | Duas constraints únicas compostas |
| Uma entrega por consumer/message | PK composta da inbox |
| Um evento por ID | PK da outbox |
| Sem dupla reversão do mesmo tipo | Índice único parcial para reversões processadas |
| Saldo não negativo e aritmética exata | Checks monetários e equação do ledger |
| Moeda/player da transação iguais aos da wallet | FK composta |
| Uma entrada por transação/wallet e por versão | Duas constraints únicas do ledger |
| Histórico imutável | Triggers contra UPDATE/DELETE/TRUNCATE do ledger |
| Payload imutável e estados terminais | Triggers para wager, inbox e outbox |
| Referências válidas | FK e trigger verificando identidade, tipo, estado e valor |
| Saldo materializado consistente | Triggers deferred verificando cadeia do ledger e sua última versão |
| Ledger apenas para operação financeira processada | Triggers deferred em ambos os lados |

`wallet_version` no ledger é metadado de persistência. A abertura positiva ocupa
a versão 1; abertura zero não gera entrada e o primeiro movimento ocupa a versão
2. Cada entrada posterior deve continuar o saldo da versão anterior. No commit,
saldo, versão e timestamp da wallet devem corresponder à última entrada. Essas
verificações usam os índices por wallet/versão e não recalculam a soma de todo o
histórico. Uma transação pode acumular vários movimentos, inclusive com efeito
líquido zero, desde que todos tenham suas entradas consecutivas.

FKs e verificações cruzadas são `DEFERRABLE INITIALLY DEFERRED`, permitindo que o
Unit of Work faça flush de múltiplas tabelas antes de verificar o estado final.
Qualquer violação aborta o commit inteiro. O usuário SQL da aplicação em produção
deve ter apenas DML necessário; o proprietário de migrations é separado. Um
proprietário/superuser pode desabilitar triggers, portanto não é um papel adequado
para requisições da aplicação. Permissões de limpeza de inbox/outbox exigem uma
política de retenção que preserve as janelas de deduplicação e publicação.

## Transação e repositórios

```ts
import { MikroORM } from '@mikro-orm/postgresql';
import { Money, WagerTransaction } from './src/domain';
import type { CreateWagerTransactionProps } from './src/domain';
import { persistenceConfig } from './src/infrastructure/persistence/mikro-orm.config';
import { MikroUnitOfWork } from './src/infrastructure/persistence/unit-of-work';

const orm = await MikroORM.init(persistenceConfig());
const unitOfWork = new MikroUnitOfWork(orm);

// Exemplo da fronteira de persistência; o use case completo também trata
// inbox, payload/hash de replay, rejeições e eventos de integração.
async function persistBet(props: CreateWagerTransactionProps, at: Date) {
  return unitOfWork.run(async repositories => {
    const wallet = await repositories.wallets.findById(props.walletId);
    if (!wallet) throw new Error('Wallet not found');
    const transaction = WagerTransaction.create(props);
    wallet.debit(Money.from(props.money.toJSON()), {
      transactionId: transaction.id, ledgerEntryId: crypto.randomUUID(), at,
    });
    transaction.markProcessed(undefined, at);
    repositories.transactions.add(transaction);
    repositories.wallets.save(wallet); // Também adiciona os novos lançamentos.
  }); // Flush, checks deferred e COMMIT; resolve apenas depois do commit.
}
```

Todos os repositórios do callback usam o mesmo EntityManager e a mesma transação.
`READ COMMITTED` mais `PESSIMISTIC_WRITE` serializa alterações de uma wallet sem
lock global. Não há autoincremento ORM de `version`: o domínio controla a versão.
Agregados carregados repetidamente no mesmo callback preservam a identidade.
`save` aceita somente a instância carregada ou adicionada naquela unidade de
trabalho, evitando sobrescrever dados com snapshots destacados. Depois do
callback, os repositórios ficam inválidos; recarregue agregados em nova transação.

`add` sempre insere; não faz upsert nem ignora conflitos. Chaves ainda inexistentes
não têm row lock: a constraint única arbitra duas inserções concorrentes. A Fase 3
adiciona advisory locks por identidade antes da consulta; as constraints continuam
protegendo acessos diretos. Após rollback, conflitos `23505` das constraints de
identidade/reversão são classificados como `RetryableTransactionError`, com o erro
SQL em `cause`. `ProcessWager` tenta novamente em outra unidade de trabalho e
compara identidade/hash antes de retornar replay ou conflito. Reversões já
processadas geram `ALREADY_REVERSED` sob o lock da wallet. O adapter não converte
indiscriminadamente violações de integridade em rejeições de negócio.

Evite abrir outra `UnitOfWork.run` dentro do callback: ela é uma transação
independente. Passe os mesmos repositórios às operações que precisam de atomicidade.
Adquira wallets em ordem determinística quando tocar mais de uma. Workers que
primeiro reclamam lotes de transações podem disputar locks com requisições; o
use case deve tratar deadlocks (`40P01`) e falhas de serialização (`40001`) com
retry limitado da operação inteira. Não existe retry automático do callback,
pois ele pode conter efeitos externos. Escopo transacional curto e limites de
tempo de acesso ao banco devem ser definidos no deployment. A Fase 3 define
`lock_timeout` local de 5 segundos e concentra o retry limitado em `ProcessWager`,
cujo callback não possui efeitos externos.

## NestJS

Importe `PersistenceModule` no módulo da aplicação e injete `UNIT_OF_WORK`.
O provider é singleton, mas cada chamada `run` cria seu próprio EntityManager.
Factories explícitas dispensam reflexão sobre parâmetros do construtor no Bun:

```ts
{
  provide: ProcessWager,
  inject: [UNIT_OF_WORK],
  useFactory: (unitOfWork: UnitOfWork) => new ProcessWager(unitOfWork),
}
```

O módulo fecha o ORM em `app.close()`; habilite `app.enableShutdownHooks()` no
bootstrap para sinais do processo. Esta fase fornece o módulo de persistência;
servidor HTTP, consumers SQS e publishers pertencem às próximas fases.

## Inbox e Outbox concorrentes

`findDue`, `findPending` e `findPendingReferences` usam
`PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) com lotes limitados a 1000.
O índice parcial da outbox ordena `coalesce(next_attempt_at, occurred_at), id`;
inclui eventos novos e retries, sem selecionar eventos futuros.

O claim dura **somente até o fim da transação**. Um publisher deve consultar,
publicar com timeout e salvar `markPublished`/`scheduleRetry` dentro do mesmo
callback de uma unidade de trabalho própria, posterior ao commit financeiro.
Não retorne o lote para publicar depois de liberar os locks. Um crash libera os
locks e permite nova tentativa. Não há lease persistido nesta fase; para evitar
transações abertas durante I/O externo, uma evolução precisa adicionar lease,
token de ownership e expiração antes de mover a publicação para fora do callback.

A entrega segue at-least-once: publicar e cair antes de salvar a confirmação pode
duplicar o evento. Consumidores deduplicam pelo ID estável; ack da fila ocorre
apenas depois do commit financeiro. Os testes verificam exclusão entre publishers
e recuperação do claim após rollback, mas não integram um broker nesta fase.

## Referências técnicas

- [MikroORM 6.6: transações e locks](https://mikro-orm.io/docs/6.6/transactions).
- [PostgreSQL: precisão e coerção de numeric](https://www.postgresql.org/docs/17/datatype-numeric.html).
