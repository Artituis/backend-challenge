# Fase 3 — casos de uso, concorrência e transações

`src/application/wagering` implementa `BetUseCase`, `WinUseCase`, `LossUseCase`,
`RefundUseCase` e `RollbackUseCase`. Todos delegam a `ProcessWager`, a fronteira
única de transação, idempotência, retries e eventos. O domínio continua puro;
a aplicação conhece portas e a infraestrutura fornece MikroORM, relógio, UUIDs,
SHA-256 e a composição NestJS em `WageringModule`.

## Uso

Importe `WageringModule` no módulo NestJS e injete o caso de uso desejado.
As factories são explícitas, sem depender de metadados de decorators no Bun.
O adapter HTTP passa o header obrigatório em `idempotencyKey`; o adapter SQS
acrescenta `delivery`. O serviço também pode ser composto diretamente:

```ts
import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWager } from './src/application/wagering/process-wager';
import { BetUseCase } from './src/application/wagering/use-cases';
import { persistenceConfig } from './src/infrastructure/persistence/mikro-orm.config';
import { MikroUnitOfWork } from './src/infrastructure/persistence/unit-of-work';
import { SystemRuntime } from './src/infrastructure/system-runtime';

const orm = await MikroORM.init(persistenceConfig());
const bet = new BetUseCase(new ProcessWager(new MikroUnitOfWork(orm), new SystemRuntime()));
try {
  const response = await bet.execute({
    providerId: 'provider-a', externalTransactionId: 'bet-123',
    idempotencyKey: 'provider-a:bet-123', walletId: 'existing-wallet',
    playerId: 'existing-player', roundId: 'round-1', gameId: 'game-1',
    money: { amount: '25.00', currency: 'BRL' },
    // Apenas para entregas da fila:
    delivery: { consumerName: 'wagering', messageId: 'sqs-message-id' },
  });
  console.log(response);
  // DeleteMessage/ack somente após execute resolver, inclusive em replay/rejeição.
} finally {
  await orm.close(true);
}
```

O resultado contém `transactionId`, `status`, `balance`, `walletVersion`,
`failureCode` (ou `null`) e `idempotentReplay`. Valores monetários são strings.
IDs internos, hash e timestamps não são aceitos do provedor. Wallets devem ter
sido abertas pelo fluxo interno da Fase 2; estes casos de uso não criam wallets.

## Uma transação SQL por tentativa

`MikroUnitOfWork.run` cria um `EntityManager.fork({ clear: true, useContext: false })`
e chama `transactional()` com `READ COMMITTED`. Todos os repositórios recebem o
mesmo manager e contexto transacional; inclusive o SQL dos advisory locks passa
por `em.execute`, que usa a conexão dessa transação.

O fluxo é:

1. Normalizar Money, validar o payload e calcular SHA-256 do JSON canônico.
2. Abrir a transação e adquirir os locks das identidades da requisição.
3. Verificar inbox, chave de idempotência e identidade externa. Em replay, ler
   a resposta persistida; uma entrega SQS nova também é registrada nesta transação.
4. Carregar a wallet com `PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`).
5. Resolver a referência, verificar reversão anterior e aplicar as regras do domínio.
6. Persistir wager, wallet/ledger quando houver movimento, resposta original,
   inbox processada quando presente e eventos de outbox.
7. Fazer flush, validar constraints diferidas e confirmar. Só então resolver a Promise.

Uma falha inclusive durante flush/COMMIT desfaz todas as escritas. Falhas de
infraestrutura propagam; o consumidor não deve confirmar a mensagem nesse caso.
Não há publicação, ack, chamada de rede ou transação aninhada dentro do callback.

## Hot wallet e três ou mais instâncias

O lock da wallet vive no PostgreSQL e dura até commit/rollback. Uma segunda ou
terceira instância espera; ao obter o lock em `READ COMMITTED`, lê o saldo já
confirmado pela anterior. Duas apostas de `60.00` disputando `100.00` produzem
um débito e uma rejeição `INSUFFICIENT_FUNDS`, sem saldo negativo ou lost update.
Wallets distintas continuam progredindo independentemente.

`version` é alterada exclusivamente pelo domínio quando um movimento positivo
altera o saldo. Não há `@Version` nem incremento automático pelo ORM. `LOSS`,
rejeição, pendência e replay não salvam a wallet nem geram ledger. O timestamp
financeiro é o máximo entre o relógio atual, a criação da operação e o último
timestamp da wallet, para tolerar relógios desalinhados entre instâncias.

Um `FOR UPDATE` não bloqueia uma chave inexistente. Por isso, antes das consultas,
adquirimos `pg_advisory_xact_lock` para cada identidade abaixo:

- `(providerId, idempotencyKey)`;
- `(providerId, externalTransactionId)`;
- `(consumerName, messageId)`, quando houver entrega SQS.

Cada identidade usa JSON com namespace e SHA-256 convertido em inteiro assinado
de 64 bits. Os IDs efetivos dos locks são deduplicados e ordenados antes de
adquisição. Não existe lock global nem mutex em memória. Uma colisão de hash
apenas serializa requisições adicionais; comparação dos campos e constraints
únicas continuam usando os valores completos. Commit, rollback ou desconexão
liberam os locks automaticamente.

A ordem é identidades → inbox/transação existente → wallet. Uma chave já
conflitante é rejeitada antes de consultar outra identidade. Referências usam
leitura sem lock e snapshots separados: uma referência `PROCESSED` é imutável
por trigger, e uma referência de outra wallet precisa ser rejeitada sem adquirir
locks financeiros na wallet alheia. A consulta de reversão anterior acontece
sob o lock da wallet; o índice único parcial permanece como defesa no banco.

## Idempotência e retries

O hash de negócio é SHA-256, UTF-8, hexadecimal minúsculo, sobre
`WagerTransaction.canonicalPayload`. `025.0` e `25.00` representam o mesmo valor.
Chave e transporte não entram nesse hash. A inbox usa outro SHA-256 sobre chave
e hash de negócio, impedindo que a mesma entrega esconda uma mudança de chave.
Receipt handles e contadores de redelivery não fazem parte da identidade.

`wager_results`, criada por `Migration202611100002`, armazena a resposta original
de submissão e proíbe UPDATE/DELETE/TRUNCATE. O campo `idempotentReplay` é acrescentado
na saída. O replay usa esse snapshot, inclusive saldo/versão históricos, nunca o
saldo corrente. Uma aposta rejeitada continua rejeitada mesmo após um depósito.
Reutilizar chave ou ID externo com identidade/payload divergente lança
`IDEMPOTENCY_CONFLICT` sem efeitos financeiros.

Deadlock (`40P01`), serialização (`40001`), timeout de lock (`55P03`) e violações
únicas conhecidas de identidade/reversão são traduzidos em `RetryableTransactionError`
**após rollback**, mantendo o erro SQL em `cause`. O Unit of Work não repete callbacks
genéricos. `ProcessWager` repete sua operação inteira em um fork novo, no máximo
quatro tentativas, com esperas de 25, 50 e 100 ms mais jitter de 0–24 ms.
`lock_timeout` é local à transação e vale 5 segundos por aquisição de lock.
Outras constraints não são convertidas em rejeições de negócio.

Uma falha de conexão durante COMMIT pode ter resultado desconhecido e não recebe
retry automático. O cliente/consumer deve reenviar com a mesma identidade; se o
commit ocorreu, o registro persistido fornece replay. Se não ocorreu, a operação
pode executar novamente. Após esgotar o retry limitado, o erro também propaga.

Registros antigos criados diretamente pelos repositórios da Fase 2 não possuem
snapshot de submissão. A migration não inventa saldos históricos de rejeições:
tentar submetê-los como replay gera `INVALID_STATE`. Uma migração de dados reais
precisaria recuperar a resposta original de uma fonte auditável antes do rollout.

## Regras e eventos

| Operação | Efeito | Validação adicional |
| --- | --- | --- |
| BET | Débito | Saldo insuficiente → `REJECTED / INSUFFICIENT_FUNDS` |
| WIN | Crédito | Referência opcional a BET processada |
| LOSS | Sem movimento | Valor zero; referência opcional a BET processada |
| REFUND | Crédito | Valor integral de BET; uma reversão por tipo |
| ROLLBACK | Direção inversa | Valor integral de BET/WIN/REFUND; débito sem saldo → `REVERSAL_INSUFFICIENT_FUNDS` |

Referências exigem mesmo provedor, player, wallet, moeda e rodada. Referência de
tipo, valor, estado ou identidade inválidos gera rejeição auditável; reversão
repetida usa `ALREADY_REVERSED`. Wallet inexistente, player/moeda incompatíveis
com a wallet ou payload estruturalmente inválido lançam erro sem criar wager,
pois não podem satisfazer as FKs/constraints do contrato financeiro.

Toda operação nova produz `WagerTransactionProcessed`, `WagerTransactionRejected`
ou `WagerTransactionPendingReference`. Um movimento também produz
`WalletBalanceChanged`, com direção, valor, saldos anterior/posterior e versão.
O envelope JSON contém ID estável, tipo, versão 1, aggregateId, correlationId,
causationId, occurredAt e data. Replay não produz eventos adicionais.

Referência ausente persiste `PENDING_REFERENCE` e confirma a inbox como **aceite
durável**, sem aplicar dinheiro. Replay retorna esse aceite original mesmo que
a referência apareça depois. O futuro worker deve executar a transição pendente,
sob o mesmo lock da wallet e em uma nova transação, com backoff/TTL, eventos e
consulta de estado atual separados da resposta de submissão. Agendamento,
consumers SQS, controllers HTTP e publicação da outbox não fazem parte desta fase.

## Verificação

`tests/integration/wagering.test.ts` executa migrations reais em schema isolado
com três instâncias de MikroORM e pools independentes. Os cenários cobrem saldo
disputado, 30 créditos simultâneos, cadeia do ledger, duplicatas HTTP/SQS,
conflitos entre wallets, reversões, pendências, falhas na outbox e no COMMIT,
rollback seguido de retry, independência entre wallets e desvio de relógio.
São três pools no mesmo processo de teste; ainda não é um teste de deployment
com três processos/containers da API.

```sh
bun run typecheck
bun test tests/domain tests/application
docker compose --profile test run --build --rm test
```

A suíte completa desta implementação passou com **190 testes**, incluindo
PostgreSQL 17 real, e typecheck estrito. Se o Docker/OneDrive falhar ao enviar
arquivos do contexto de build, copie Dockerfile, package.json, bun.lock,
tsconfig.json, bunfig.toml, src e tests para um diretório temporário fora do
OneDrive, construa a imagem `backend-challenge-test` lá e execute
`docker compose --profile test run --rm test` no projeto original.
