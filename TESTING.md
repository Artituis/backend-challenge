# Fase 5 — integração, concorrência e recuperação

## Execução

Pré-requisitos: Docker Desktop/Engine com Compose v2 e Bun. Execute na raiz:

```sh
bun run test:integration
bun run test:load
```

O primeiro comando cria um projeto Compose exclusivo, sobe PostgreSQL 17 e
LocalStack 4.10.0, espera os healthchecks, constrói o runner Bun 1.3.2, verifica
TypeScript estrito e executa **todos** os testes, incluindo integração. Ao terminar,
remove os containers e volumes desse projeto. Não publica portas no host nem usa
o banco da aplicação. `compose.test.yaml` é independente de `compose.yaml`.

Cada suíte usa um schema exclusivo; os cenários de resiliência usam um schema e
três filas FIFO novos por teste. Nenhum teste de integração substitui o PostgreSQL
ou o SQS por armazenamento/publicação em memória. As injeções de falha usam
constraints/triggers SQL, interrupção real do processo ou uma barreira antes/depois
de operações reais. Os testes unitários preexistentes continuam isolados.

Para serviços já disponíveis, configure **ambas** `TEST_DATABASE_URL` (nome do
banco terminado em `_test`) e `TEST_SQS_ENDPOINT`, além das credenciais AWS locais.
Nesse caso os mesmos comandos usam esses serviços e removem apenas seus próprios
schemas e filas. O script explícito de integração falha se faltar infraestrutura;
não aceita uma execução composta apenas por testes ignorados.

```sh
bun run typecheck
bun run test:unit
```

`bun test` continua disponível para desenvolvimento: sem variáveis de infraestrutura,
ignora as suítes de integração. Para validar a Fase 5 use `test:integration`.

## Cobertura e evidência

| Arquivo | Cenários |
| --- | --- |
| `tests/integration/persistence.test.ts` | Todas as migrations up/down até zero/up; ausência de tabelas residuais; constraints SQL por código/nome; unicidade player/moeda; atomicidade Wallet/Wager/Ledger/Inbox/Outbox; histórico imutável; SKIP LOCKED |
| `tests/integration/wagering.test.ts` | Duas BETs de 80 sobre 100; 50 cópias da mesma aposta; 20 wallets × 5 débitos; três pools independentes; disputa de referências; resposta original imutável; rollback na confirmação; falha real de INSERT da Outbox |
| `tests/integration/messaging.test.ts` | Redelivery do mesmo MessageId; dedup persistente da Inbox; FIFO; DLQ e redrive nativo; fila de eventos removida/recriada; backoff da publicação; shutdown Nest |
| `tests/integration/resilience.test.ts` | SIGKILL antes do ACK e após envio ao SQS; serviço Nest reiniciado recupera Inbox/Outbox; quatro publishers/pools concorrentes; REFUND e ROLLBACK fora de ordem; backoff exponencial com teto, retenção, resolução e expiração |

O cenário 100 − 80 comprova **um lançamento de débito**. O ledger completo tem
dois registros: o crédito auditável de abertura e o débito da aposta. Excluir a
abertura da reconstrução do saldo produziria uma invariante incorreta.

`tests/support/invariant.ts` reconstrói todos os saldos do schema com `SUM` em
`numeric` no PostgreSQL, incluindo wallets sem lançamentos. É executado depois de
cada teste de integração, também nos caminhos de falha/limpeza. Valores monetários
nunca são convertidos em `number` para essa verificação.

Os testes de morte não usam apenas uma exceção como substituto de queda. O processo
filho anuncia a barreira por stdout e o pai envia `SIGKILL`, esperando a saída.
Antes do ACK, o teste verifica commit financeiro, Inbox processada e Outbox pendente;
espera a expiração real da visibility e verifica o mesmo MessageId com receive count
incrementado. Um novo processo executa `src/worker.ts`, confirma a entrega e publica
os eventos. Depois do envio ao broker, o teste mata o publisher ainda com a transação
SQL aberta e verifica que outro publisher consegue recuperar a claim.

A deduplicação imediata do envio repetido usa o mesmo eventId no SQS FIFO. Isso
valida recuperação **at least once** dentro da janela de dedup do broker; não promete
entrega exatamente uma vez para consumidores externos depois dessa janela.

O relógio é controlado nos testes de backoff/TTL para verificar limites exatos sem
esperar minutos. Persistência, locks, jobs, transporte e workers são reais. Há teste
de reinício do **serviço**, sem reiniciar o PostgreSQL que atende outras suítes.

## Carga

`bun run test:load` usa o mesmo ambiente isolado e salva
`reports/load-<timestamp>.json` no host. O relatório inclui configuração e ambiente,
throughput de submissão e de conclusão incluindo drenagem, taxa de erro, p50/p95/p99
HTTP, envio SQS e commit SQS observado, espera por locks e atraso da Outbox.

Ainda não há controllers HTTP de produção neste repositório. O script abre um
endpoint HTTP local `POST /wagers` com Bun e resolve `ProcessWager` pelo verdadeiro
`WageringModule` do Nest. Ele mede rede HTTP + caso de uso + PostgreSQL, além do canal
SQS + ConsumerWorker + PostgreSQL. Não mede autenticação, gateway, TLS ou controllers
de uma API futura. O adaptador existe apenas durante a carga.

Parâmetros (variáveis de ambiente):

| Variável | Padrão | Significado |
| --- | --- | --- |
| `LOAD_DURATION_SECONDS` | 30 | Janela de submissão |
| `LOAD_CONCURRENCY` | 20 | Clientes paralelos |
| `LOAD_WALLETS` | 20 | Wallets pré-carregadas |
| `LOAD_MAX_REQUESTS` | 10000 | Limite de submissões e memória de amostras |
| `LOAD_DRAIN_SECONDS` | 120 | Prazo para terminar processamento e publicação |

Exemplo PowerShell:

```powershell
$env:LOAD_DURATION_SECONDS = '60'
$env:LOAD_CONCURRENCY = '50'
$env:LOAD_WALLETS = '50'
bun run test:load
```

Metodologia: carga fechada (cada cliente espera sua requisição), metade HTTP/metade
SQS, metade das requisições na mesma wallet, demais distribuídas, débito de 0.01 BRL,
quatro publishers, até 32 consumidores. Sem warmup; o relatório identifica a execução
como fria. O tempo de drenagem é reportado separadamente para não confundir aceitação
na fila com processamento financeiro concluído. O saldo inicial permite executar até
o limite máximo configurável sem rejeições esperadas por falta de saldo.

As latências SQS de conclusão são observadas por polling do banco: incluem atraso
de observação. As métricas de lock vêm de `pg_stat_activity` (`wait_event_type = Lock`)
e `pg_stat_database`; a soma de sessões esperando por amostra **não** é uma contagem
de conflitos únicos ou de retries. O lag é a idade do evento pendente mais antigo,
amostrada a cada 100ms mais o custo das consultas. O gerador, os workers e o coletor
compartilham recursos; LocalStack não representa capacidade ou latência da AWS.

A execução falha se houver erro de submissão, timeout de drenagem, quantidade
inesperada de resultados, Outbox pendente ou saldo incorreto. A validação final
confere tanto a invariante global quanto o saldo esperado por quantidade de BETs.
O relatório não define meta de RPS e não deve ser usado como benchmark de produção.

Smoke executado em 10/11/2026: 5 segundos, 8 clientes, 20 wallets, 476 operações
(238 HTTP + 238 SQS), zero erros, 93,42 submissões/s e 61,08 conclusões/s incluindo
2,70s de drenagem. HTTP p50/p95/p99: 157,51/317,12/404,76ms; commit SQS observado:
481,64/3617,92/3712,31ms; lag máximo da Outbox: 1488,34ms; máximo de quatro sessões
esperando locks e zero deadlocks. Invariante financeira válida. Ambiente: Bun 1.3.2,
PostgreSQL 17.11, LocalStack 4.10.0, Docker Linux x64, 32 CPUs lógicas e aproximadamente
15,2GiB visíveis ao container. Esses números documentam uma verificação curta local,
sem isolamento de CPU; o JSON completo fica em `reports/`.
