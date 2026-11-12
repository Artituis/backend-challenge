# Mensageria — Fase 4

`src/worker.ts` inicia um application context NestJS, sem servidor HTTP.
O consumer chama `ProcessWager.execute`, compartilhado pelos casos de uso
BET/WIN/LOSS/REFUND/ROLLBACK. O adapter SQS não contém lógica financeira.

## Executar

```powershell
Copy-Item .env.example .env
docker compose up --build -d worker
docker compose logs -f worker
```

O Compose aguarda PostgreSQL e LocalStack, executa migrations e provisiona as
filas antes de iniciar os workers. `docker compose up -d --scale worker=3 worker`
inicia réplicas concorrentes; `docker compose stop worker` envia SIGTERM.

| Fila                          | Função                                                 |
| ----------------------------- | ------------------------------------------------------ |
| `wager-transactions.fifo`     | Comandos; redrive nativo após cinco recebimentos       |
| `wager-transactions-dlq.fifo` | Falhas permanentes/esgotadas; arquivadas em PostgreSQL |
| `wager-events.fifo`           | Eventos publicados pela outbox                         |

No host: `bun install --frozen-lockfile`, `bun run db:migrate`,
`bun run sqs:provision` e `bun run start:worker`, com os serviços já iniciados.
`SQS_ENDPOINT` é `http://localhost:4566` no host e `http://localstack:4566` no
Compose. A estratégia `dynamic` gera URLs acessíveis em ambos os ambientes
([LocalStack SQS](https://docs.localstack.cloud/aws/services/sqs/)). MiniStack pode
substituir o endpoint se implementar as operações SQS FIFO usadas pelo adapter;
a validação automatizada deste projeto usa LocalStack.

Em AWS, omita o endpoint, use credenciais IAM e provisione filas via infraestrutura.
As credenciais `test` são locais. O provisionamento é idempotente: mudanças em
`SQS_MAX_RECEIVES` requerem `docker compose run --rm sqs-init` novamente.

## Entrada

O corpo é um `WagerCommand` JSON, sem envelope SNS:

```json
{
  "providerId": "provider-1",
  "externalTransactionId": "bet-123",
  "idempotencyKey": "bet-123",
  "walletId": "wallet-existente",
  "playerId": "player-da-wallet",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

REFUND/ROLLBACK incluem `referenceExternalTransactionId`. O produtor deve enviar
`MessageGroupId` estável por wallet e `MessageDeduplicationId` estável por comando.
A wallet deve existir previamente. `delivery` é construído pelo consumer com o
MessageId real do SQS; o corpo não pode substituir essa identidade.

## Commit, inbox e recuperação

Inbox usa `(consumerName, messageId)` e SHA-256 do payload canônico junto da chave
de idempotência. Inbox, wager, resultado, ledger, wallet e outbox são confirmados
atomicamente. Duplicatas retornam o resultado salvo; payload diferente com a
mesma identidade gera conflito. Os locks e constraints das fases anteriores
continuam protegendo os efeitos financeiros.

| Resultado                                                             | Ação                                             |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| Processado, rejeição persistida ou pendência de referência            | Ack após commit                                  |
| Erro terminal de negócio lançado antes de persistir wager             | Commit de disposição `TERMINAL`, depois ack      |
| Conectividade, deadlock, commit ambíguo ou falha desconhecida         | Sem ack; retry exponencial com jitter, até 900 s |
| JSON inválido, conflito de identidade, erro permanente de domínio/SQL | Commit de `DEAD_LETTER`, envio à DLQ, depois ack |
| Limite de recebimentos                                                | Mesmo fluxo persistente de DLQ                   |
| Falha ao persistir disposição ou publicar na DLQ                      | Sem ack; entrega recuperável                     |

O redrive nativo também protege contra crashes anteriores à classificação.
`message_dispositions` guarda fila, ID, SHA-256, corpo e motivo. Uma disposição
existente retoma o encaminhamento sem executar o caso de uso novamente.
A DLQ é consumida para **quarentena durável** (`QUARANTINED`) antes da deleção;
não há ciclos automáticos de reenvio. Investigue a causa e reenvie manualmente
com as identidades de negócio originais. A quarentena permanece no banco mesmo
quando a DLQ estiver vazia. Não há política automática de exclusão desses registros.

Cada receiver recebe uma mensagem por vez, preservando a ordem do grupo durante
retry. SQS pode entregar várias mensagens de um grupo no mesmo lote, por isso
este adapter evita lotes concorrentes
([AWS: FIFO delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html)).

Heartbeat renova visibilidade a cada um terço do prazo. SIGTERM/SIGINT cancelam
long polls e novas leituras, concedendo 25 s para mensagens em voo. Ao exceder
o prazo, o consumer encerra heartbeat, devolve visibilidade e impede ack tardio.
Um commit tardio continua protegido pela inbox. Se devolver visibilidade falhar,
a expiração natural permite recuperação. Publishers e pendências concluem sua
unidade de trabalho antes do fechamento do pool. Timeout SQL: 15 s por statement
e 5 s por lock; SQS: 5 s por chamada, além do tempo de long polling. Compose
concede 60 s para encerrar. SIGKILL é recuperado por rollback/expiração.

## Outbox

Cada publisher seleciona um evento devido com `FOR UPDATE SKIP LOCKED`, publica
com timeout e grava `publishedAt` na mesma unidade de trabalho. O lock permanece
durante o I/O; não se libera o evento antes do envio. Há dois publishers por
processo. Ajuste concorrência considerando o pool de dez conexões.

Falhas incrementam `attempts` e agendam `nextAttemptAt`: 1 s, 2 s, 4 s, até 5 min.
Eventos pendentes não são descartados por limite de tentativas. Logs incluem
`eventId` e contador. Crash após envio e antes do commit pode duplicar o evento.
O ID do evento e a deduplicação FIFO são estáveis, mas a janela FIFO é finita;
consumidores devem deduplicar persistentemente por `eventId`
([AWS: FIFO key terms](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-key-terms.html)).
Publishers concorrentes não garantem ordem financeira global: projeções devem
considerar `walletVersion` e detectar lacunas. A garantia é at-least-once.

## Referências pendentes

A migration `202611100003` adiciona `pending_reference_jobs`, disposições e
`REFERENCE_EXPIRED`. Um trigger agenda pendências no mesmo commit do wager e a
migration inclui backfill. Cada worker reclama um job com SKIP LOCKED e usa as
mesmas regras financeiras de `ProcessWager`, sob locks de transação e wallet.

Referência ausente ou ainda pendente agenda retry de 1 s até 5 min. TTL padrão:
24 horas desde `createdAt`. O agendamento nunca ultrapassa o TTL; a primeira
execução após o prazo rejeita com `REFERENCE_EXPIRED`, remove o job e gera evento
sem movimento financeiro. Referências terminais inválidas seguem as rejeições
existentes. Crash desfaz claim e efeitos juntos; conclusão remove o job no commit.

`wager_results` continua imutável: replay de uma aceitação pendente retorna a
resposta original mesmo depois de resolvida. O estado atual fica no wager e nos
novos eventos. Rollback da migration recusa dados com `REFERENCE_EXPIRED`, pois
a versão anterior não representa esse resultado.

## Configuração e testes

`.env.example` inclui endpoint, região, concorrências, visibilidade e TTL.
Outras opções: `SQS_QUEUE_NAME`, `SQS_DLQ_NAME`, `SQS_EVENTS_QUEUE_NAME`,
`SQS_POLL_SECONDS`, `SQS_REQUEST_TIMEOUT_MS`, `WORKER_SHUTDOWN_MS`, `WORKER_IDLE_MS`,
`PENDING_REFERENCE_BASE_DELAY_MS` e `PENDING_REFERENCE_MAX_DELAY_MS`.
Limites são validados no bootstrap.

```sh
docker compose --profile test run --build --rm test
docker compose --profile test stop postgres-test
```

Testes criam e removem apenas schemas/filas de nomes aleatórios. Fora do Compose,
integração exige `TEST_DATABASE_URL` terminando em `_test` e `TEST_SQS_ENDPOINT`.
Sem essas variáveis, as respectivas integrações são skipped. A suíte cobre
commit/ack, redelivery, redrive nativo, quarentena, publishers concorrentes,
crash após publicação, backoff, TTL e shutdown.

Se Docker Desktop apresentar `invalid file request` no OneDrive, construa a
imagem usando contexto tar por stdin e execute o Compose sem `--build`.

```powershell
New-Item -ItemType Directory -Force .tools | Out-Null
tar -cf .tools/messaging-context.tar Dockerfile package.json bun.lock tsconfig.json bunfig.toml src tests
cmd /c 'docker build -t backend-challenge-test -t backend-challenge-worker -t backend-challenge-migrate -t backend-challenge-sqs-init - < .tools\messaging-context.tar'
docker compose -p backend-challenge up -d --no-build worker
docker compose -p backend-challenge --profile test run --rm test
```

Esse caminho foi usado na validação local devido à leitura do contexto no OneDrive.
