# Distributed Wagering Processor

Processador de apostas com NestJS, Bun, MikroORM, PostgreSQL e SQS FIFO/LocalStack.
HTTP e SQS compartilham regras financeiras, idempotência persistente, Inbox e
Transactional Outbox. Inclui logs JSON, métricas Prometheus, health checks e testes
de concorrência/recuperação com serviços reais.

Decisões, invariantes, autenticação, erros e limitações estão em
[ARCHITECTURE.md](ARCHITECTURE.md). O enunciado anterior foi preservado em
[CHALLENGE.md](CHALLENGE.md). Detalhes das fases anteriores:
[PERSISTENCE.md](PERSISTENCE.md), [WAGERING.md](WAGERING.md),
[MESSAGING.md](MESSAGING.md) e [TESTING.md](TESTING.md).

## Setup rápido com Docker Compose

Requisitos: Docker Desktop/Engine ativo, Compose v2 e portas locais 3000, 5432 e
4566 disponíveis. Bun local só é necessário para desenvolvimento/scripts de teste;
o Dockerfile usa Bun 1.3.2 e instala dependências com lockfile congelado.

1. Na raiz, copie `.env.example` para `.env`. Em PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   Em Bash: `cp .env.example .env`. Se o arquivo já existir, preserve suas configurações.

2. Inicie a aplicação:

   ```sh
   docker compose up --build -d
   docker compose ps
   ```

   Em instalações com o executável legado, o equivalente é
   `docker-compose up --build -d`. O Compose inicia PostgreSQL e LocalStack, executa
   as migrations, provisiona três filas FIFO e inicia API/workers. Não é necessário
   criar tabelas ou filas manualmente. Aguarde API e worker ficarem `healthy`.

3. Confira saúde e métricas:

   ```sh
   curl http://localhost:3000/health/live
   curl http://localhost:3000/health/ready
   curl http://localhost:3000/metrics
   docker compose logs --tail 30 api worker
   ```

   Em Windows PowerShell use `curl.exe` para o binário curl, ou
   `Invoke-RestMethod http://localhost:3000/health/ready`.

   Readiness saudável:

   ```json
   { "status": "ok", "dependencies": { "postgres": "up", "sqs": "up" } }
   ```

4. Para três instâncias consumidoras/publicadoras:

   ```sh
   docker compose up -d --scale worker=3
   ```

   Cada worker expõe internamente `/health/live`, `/health/ready` e `/metrics` na
   porta 3001. Não há conflito de porta no host. Para inspecionar uma réplica:

   ```sh
   docker compose exec --index 1 worker bun -e "console.log(await (await fetch('http://localhost:3001/metrics')).text())"
   ```

5. Para parar sem apagar o volume PostgreSQL: `docker compose down`.
   LocalStack nesta configuração é descartável; ao reiniciar, o provisionamento
   recria as filas, mas mensagens ainda não consumidas não são persistidas pelo
   Compose. Outbox confirmada no banco continua recuperável.

As credenciais do `.env.example` são locais. **A autenticação atual é no-op**:
`ProviderIdentityPort` é o ponto de extensão, não uma validação de JWT. A API é
publicada em `127.0.0.1`. Integração de IdP e autorização estão descritas na arquitetura.

## Desenvolvimento local

```sh
bun install --frozen-lockfile
docker compose up -d postgres localstack
docker compose run --rm migrate
docker compose run --rm sqs-init
bun run start
```

Em outro terminal, execute `bun run start:worker`. O `.env` aponta PostgreSQL/SQS
para localhost. Se a API do Compose estiver ativa, pare-a com
`docker compose stop api` antes de usar a mesma porta local.

| Configuração | Padrão / finalidade |
| --- | --- |
| `DATABASE_URL` | Conexão PostgreSQL obrigatória; nunca registrar em logs |
| `HTTP_PORT` | 3000, porta publicada pelo Compose |
| `PORT` | 3000, listener da API fora do Compose |
| `WORKER_HEALTH_PORT` | 3001, listener operacional do worker |
| `AWS_REGION` / credenciais | us-east-1 / test no LocalStack; usar IAM em AWS |
| `SQS_ENDPOINT` | http://localhost:4566 local; omitir para AWS |
| `SQS_QUEUE_NAME` | wager-transactions.fifo |
| `SQS_DLQ_NAME` | wager-transactions-dlq.fifo |
| `SQS_EVENTS_QUEUE_NAME` | wager-events.fifo |
| `CONSUMER_CONCURRENCY` / `OUTBOX_CONCURRENCY` | 4 / 2 por processo |
| `SQS_MAX_RECEIVES` / `SQS_VISIBILITY_SECONDS` | 5 / 60 segundos |
| `SQS_REQUEST_TIMEOUT_MS` / `SQS_POLL_SECONDS` | 5000 / 20 segundos de long poll |
| `WORKER_SHUTDOWN_MS` / `WORKER_IDLE_MS` | 25000 / 1000 |
| `PENDING_REFERENCE_TTL_MS` | 86400000, 24 horas |
| `PENDING_REFERENCE_BASE_DELAY_MS` / `PENDING_REFERENCE_MAX_DELAY_MS` | 1000 / 300000 |

Migrations: `bun run db:migrate`, `bun run db:pending`, `bun run db:rollback`.
Rollback não apaga incompatibilidades financeiras silenciosamente; execute-o apenas
quando apropriado ao ambiente. As quatro migrations são versionadas no repositório.

## Exemplos HTTP executáveis (PowerShell)

Valores monetários são **strings**, com no máximo duas casas decimais. Headers,
payloads e respostas financeiras não são registrados pelo logger da aplicação.

### Criar wallet e consultar saldo

```powershell
$base = 'http://localhost:3000'
$playerId = [guid]::NewGuid().ToString()
$createBody = @{
  playerId = $playerId
  initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json
$wallet = Invoke-RestMethod -Method Post -Uri "$base/wallets" -ContentType 'application/json' -Body $createBody
$walletId = $wallet.id
Invoke-RestMethod "$base/wallets/$walletId"
```

Retorna 201 com `id`, `playerId`, `balance` e `version:1`. Saldo inicial positivo
gera OPENING e ledger CREDIT atomicamente. Repetir player/moeda retorna 409.

### Submeter BET, repetir com idempotência e consultar

```powershell
$externalId = [guid]::NewGuid().ToString()
$headers = @{
  'Idempotency-Key' = "provider-a:$externalId"
  'X-Correlation-Id' = [guid]::NewGuid().ToString()
}
$bet = @{
  providerId = 'provider-a'
  externalTransactionId = $externalId
  playerId = $playerId
  walletId = $walletId
  roundId = 'round-987'
  gameId = 'fortune-chimp'
  kind = 'BET'
  money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -Headers $headers -ContentType 'application/json' -Body $bet
$transactionId = $result.transactionId
$result
Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -Headers $headers -ContentType 'application/json' -Body $bet
Invoke-RestMethod "$base/wagering/transactions/$transactionId"
Invoke-RestMethod "$base/providers/provider-a/wagering/transactions/$externalId"
```

A primeira resposta tem `status:PROCESSED`, saldo `75.00`, `walletVersion:2`,
`failureCode:null`, `idempotentReplay:false`. A segunda conserva resultado/saldo e
retorna `idempotentReplay:true`, sem outro débito. Alterar o valor com a mesma chave
retorna 409. PowerShell lança exceção para HTTP 4xx/5xx; consulte o corpo da resposta
para o código. PENDING_REFERENCE retorna 202; sua consulta posterior mostra o
estado atual, enquanto replay preserva a resposta original.

Equivalente curl para uma BET (substitua WALLET_ID e PLAYER_ID):

```sh
curl -i http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-001' \
  -H 'X-Correlation-Id: demo-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-001","walletId":"WALLET_ID","playerId":"PLAYER_ID","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

### Ledger e reconciliação

```powershell
$page = Invoke-RestMethod "$base/wallets/$walletId/ledger?limit=1"
$page.entries
if ($page.nextCursor) {
  $cursor = [uri]::EscapeDataString($page.nextCursor)
  Invoke-RestMethod "$base/wallets/$walletId/ledger?limit=50&cursor=$cursor"
}
Invoke-RestMethod -Method Post -Uri "$base/wallets/$walletId/reconciliation"
```

Paginação por versão crescente, cursor opaco vinculado à wallet, limite 1–1000
(padrão 50). Reconciliação retorna `storedBalance`, `calculatedBalance`, `difference`,
`consistent` e `checkedEntries` (string inteira). Neste exemplo: saldo `75.00`,
diferença `0.00`, `consistent:true`, dois lançamentos contando OPENING. Divergências
são sinalizadas em log/métrica, sem correção automática.

| HTTP | Significado |
| --- | --- |
| 200 / 201 | Consulta/processamento concluído / wallet criada |
| 202 | Referência pendente, persistida para reprocessamento |
| 400 | JSON, campos ou dinheiro inválidos; header obrigatório ausente |
| 404 | Rota/recurso consultado inexistente |
| 409 | Conflito de idempotência ou wallet duplicada |
| 422 | Regra de negócio rejeitada |
| 500 | Falha permanente/invariante interna |
| 503 | Infraestrutura indisponível/retries esgotados; reenviar com a mesma chave |

## Entrada SQS

O contrato de entrada é **JSON plano**, não `{type,data}`. Mesmo payload de negócio
do HTTP, acrescentando `idempotencyKey` e, opcionalmente, `correlationId`:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-sqs-001",
  "idempotencyKey": "provider-a:bet-sqs-001",
  "correlationId": "demo-sqs-001",
  "walletId": "WALLET_ID",
  "playerId": "PLAYER_ID",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Enviar à fila `wager-transactions.fifo` com MessageGroupId por wallet e
MessageDeduplicationId estável. A Inbox usa MessageId do broker, não do body.
Os eventos de saída têm envelope versionado e vão para `wager-events.fifo`.
O worker arquiva a DLQ no PostgreSQL; ela pode ficar vazia após a quarentena.

## Testes

```sh
bun run typecheck
bun run test
bun run test:unit
bun run test:integration
bun run test:concurrency
bun run test:load
```

| Comando | Cobertura / requisitos |
| --- | --- |
| `test` | Todas as suítes; integração é ignorada quando TEST_* não está configurado |
| `test:unit` | Domínio, aplicação, consumidor e observabilidade; não precisa Docker |
| `test:integration` | Typecheck e todos os testes em PostgreSQL/LocalStack reais, incluindo HTTP/health |
| `test:concurrency` | Wagering/resiliência: 50 replays, disputa de saldo, wallets paralelas, >=3 pools independentes, crashes de processos reais, publishers e referências |
| `test:load` | Carga pelo handler HTTP final + SQS, relatório JSON e verificação do ledger |
| `test:coverage` | Cobertura Bun; integração exige infraestrutura configurada |

Deixe `TEST_DATABASE_URL` e `TEST_SQS_ENDPOINT` **ambos ausentes** para os scripts
provisionarem projeto Compose exclusivo, sem portas no host nem volumes da aplicação.
Eles aguardam saúde, constroem o runner e removem os próprios containers/volumes no
final. Se usar infraestrutura existente, configure ambas as variáveis e credenciais
AWS; o nome do banco precisa terminar em `_test`. Cada suíte isola schema/filas.
O comando explícito de integração não aceita sucesso baseado apenas em skips.

Alternativa sem Bun local: `docker compose --profile test run --build --rm test`.
Para essa alternativa, encerre os serviços de teste quando terminar com
`docker compose --profile test stop postgres-test`.

Carga padrão: 30 segundos, concorrência 20, 20 wallets, até 10000 requisições,
50% HTTP/50% SQS e 50% em hot wallet. Exemplo curto em PowerShell:

```powershell
$env:LOAD_DURATION_SECONDS = '10'
$env:LOAD_CONCURRENCY = '10'
$env:LOAD_MAX_REQUESTS = '200'
bun run test:load
```

Relatórios em `reports/load-*.json`: ambiente, throughput, p50/p95/p99, taxa de erro,
espera por locks, idade da outbox e invariante final. Latência SQS até commit é
observada por polling e inclui atraso de amostragem. Não há meta artificial de RPS.
Metodologia e cenários detalhados em [TESTING.md](TESTING.md).

## Operação e diagnóstico

Logs JSON carregam correlationId/messageId/transactionId/walletId/providerId;
campos indisponíveis ficam null. Não registrar payloads, valores, tokens ou SQL em
loggers adicionais. Os IDs devem ser opacos. `/metrics` expõe contadores por status,
duplicatas/retries, conflitos, DLQ, divergências e histogramas HTTP/SQS/outbox.

Coletar API e cada réplica worker separadamente. Os contadores são voláteis e
reiniciam com o processo; o banco continua sendo a auditoria. Outbox lag usa
`publishedAt - occurredAt`, incluindo o tempo anterior ao commit: é aproximação
do atraso commit→publicação, não medição exata do WAL. Consulte as definições e
limites de todas as métricas em [ARCHITECTURE.md](ARCHITECTURE.md).

Readiness verifica banco e as três filas a cada probe, com timeout, retornando 503
quando alguma dependência falha. Liveness permanece 200 durante indisponibilidade
de dependências após bootstrap. Não usar liveness como teste de PostgreSQL/SQS.
