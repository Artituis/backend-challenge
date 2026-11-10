# Arquitetura — domínio, persistência e aplicação

A Fase 3 implementa os cinco casos de uso, idempotência persistente com resposta
original, concorrência por wallet e commit atômico. O desenho, exemplos e testes
estão em [WAGERING.md](WAGERING.md).

O domínio puro fica em `src/domain`, com testes em `tests/domain`. Essa camada
não contém NestJS, ORM, decorators, I/O, geração de IDs ou relógio global.
IDs, timestamps e hashes chegam pela aplicação. A Fase 2 adiciona MikroORM,
PostgreSQL, migrations e um módulo NestJS em `src/infrastructure/persistence`.
Configuração, decisões de persistência e execução estão em [PERSISTENCE.md](PERSISTENCE.md).
`src/domain/index.ts` exporta a API pública.

## Precisão monetária

`Money.from({ amount, currency })` aceita exclusivamente strings decimais, sem
espaços, com zero, uma ou duas casas. A representação externa é normalizada para
duas casas: `"001.2"` vira `"1.20"`, e `"-0.00"` vira `"0.00"`.
`toString()` retorna apenas o decimal; `toJSON()` inclui a moeda.

A aritmética usa centavos em `bigint`, sem converter dinheiro para `number`.
Assim, adição, subtração e negação são exatas mesmo além de `Number.MAX_SAFE_INTEGER`.
O domínio não estabelece o limite de magnitude do tipo SQL. O adapter limita a
36 dígitos inteiros e 2 casas decimais, sem truncar ou arredondar valores.

**Política de arredondamento: nenhum arredondamento implícito.** `1.005`, `1.999`
e até `1.000` são rejeitados. Não existem multiplicação ou divisão monetária nesta
API. Um cálculo futuro de odds deve definir sua própria política explícita antes
de produzir `Money`.

Valores negativos são necessários para diferenças e reconciliação, portanto são
permitidos no VO. Wallets, movimentos e contratos de transação impõem suas próprias
restrições de sinal. Todos os métodos binários, inclusive `equals`, rejeitam moedas
diferentes. A moeda é validada sintaticamente como três letras ASCII maiúsculas;
a lista de moedas habilitadas deve ser configurada na aplicação.

## Encapsulamento e reidratação

Os construtores das entidades e do VO são privados. O estado mutável das entidades
usa campos privados ECMAScript (`#`), sem setters. Identidades e snapshots são
congelados. `Date` é copiado tanto na entrada quanto nos getters. O payload da outbox
é copiado e congelado recursivamente; contém apenas JSON, sem instâncias de `Money`,
`Date`, `bigint`, ciclos ou números não finitos.

As factories `rehydrate` restauram snapshots diretamente, sem executar transições,
gerar lançamentos, incrementar versões ou resolver referências. Ainda verificam
integridade estrutural: saldo não negativo, moeda, contadores, datas e coerência
entre status e metadados. A reidratação do ledger também verifica sua equação.

## Wallet e ledger

`Wallet.open` inicia a versão em 1. Saldo inicial positivo exige os IDs da transação
interna `OPENING` e do lançamento; a abertura produz um crédito de zero até o saldo
inicial, sem elevar a versão. A aplicação cria essa transação com
`WagerTransaction.createOpening`, marca seu processamento e persiste tudo junto.
`create` rejeita `OPENING`; adapters HTTP/SQS devem chamar apenas `create`.

`debit` e `credit` recebem `Money` e `{ ledgerEntryId, transactionId, at }`.
Retornam o lançamento produzido; zero retorna `undefined`. Uma operação positiva:

1. Valida moeda, sinal, metadados, data e duplicação dentro desta unidade de trabalho.
2. Calcula o próximo saldo e verifica não-negatividade e capacidade do contador.
3. Constrói o lançamento imutável e verifica a equação monetária.
4. Atualiza saldo, versão, data e a coleção de novos lançamentos.

Uma falha anterior à aplicação preserva todos os campos. Valor zero não altera
saldo, data, versão ou ledger. `debit(money, context, true)` identifica reversão
para produzir `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS`.

`ledgerEntries` é um snapshot dos lançamentos criados **nesta unidade de trabalho**,
incluindo abertura. Não contém histórico persistido. O adapter persiste esses
lançamentos uma vez e descarta a instância ao concluir a unidade de trabalho;
recarrega com `rehydrate` na próxima. Não há método para apagar lançamentos.
As IDs de movimento repetidas são detectadas localmente como defesa adicional,
mas essa coleção **não é uma garantia de idempotência persistente**.

## Transações e referências

| Estado atual | Próximos estados permitidos |
| --- | --- |
| `PENDING` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PROCESSED`, `REJECTED`, `FAILED` | Nenhum |

`markPendingReference` exige uma referência externa declarada. A repetição enquanto
se espera uma referência é permitida. Os estados terminais rejeitam inclusive a
tentativa de repetir a mesma transição, lançando `InvalidTransactionStateError`.
Replay é uma consulta ao resultado persistido, não uma nova execução.

`markProcessed(reference, at)` recebe a entidade referenciada, quando declarada,
para validar as regras antes de gravar seu ID interno. Uma referência deve estar
`PROCESSED` e corresponder ao ID externo, provedor, player, wallet, moeda e rodada.
`gameId` pertence ao payload de idempotência; não adicionamos uma restrição de
igualdade de jogo além das regras de referência exigidas no README.

- `BET`: débito positivo, sem referência.
- `WIN`: crédito positivo; referência opcional a `BET`, sem exigir o mesmo valor.
- `LOSS`: valor zero e nenhum ledger; pode referenciar `BET`.
- `REFUND`: crédito igual ao valor integral de uma `BET` processada.
- `ROLLBACK`: valor integral de `BET`, `WIN` ou `REFUND` processada, com direção inversa.
- `OPENING`: crédito positivo interno, sem referência.

Decisões adicionais: operações financeiras exigem valor estritamente positivo;
`LOSS` exige zero. `BET` não aceita referência. `WIN`/`LOSS` com referência
declarada também aguardam sua resolução. Referência própria é proibida. Uma nova
transação nunca herda metadados terminais de um objeto de entrada mais amplo.

`ledgerDirectionFor` calcula a direção e valida referências; `LOSS` lança erro
porque não possui direção. `affectsBalance` descreve o efeito do **tipo**, não uma
autorização para aplicar uma transação rejeitada. O use case deve verificar o
estado e a idempotência antes de chamar a wallet.

## Idempotência

`assertIdempotentReplay` compara provedor, ID externo, chave e hash. Divergência
gera `IDEMPOTENCY_CONFLICT`, inclusive a reutilização do ID externo com outra chave.
A chave explícita recebida da aplicação é a fonte da verdade; o domínio não a gera.

`WagerTransaction.canonicalPayload` retorna JSON com chaves em ordem lexicográfica,
incluindo as chaves de `money`. O valor monetário é normalizado; referência ausente
é `null`. Inclui `externalTransactionId`, `gameId`, `kind`, `money`, `playerId`,
`providerId`, `referenceExternalTransactionId`, `roundId` e `walletId`. Exclui ID
interno, chave de idempotência, hash, timestamp e metadados de transporte.

O adapter deve calcular **SHA-256 sobre os bytes UTF-8 desse JSON**, representado
em hexadecimal minúsculo, e fornecer o resultado como `payloadHash`. O domínio
compara esse fingerprint opaco; não implementa criptografia nem aceita o hash
fornecido pelo provedor como confiável. A inbox pode usar SHA-256 do envelope
canônico completo quando também precisar detectar alterações nos metadados.

## Inbox e outbox

`InboxMessage.receive` inicia sem processamento. `assertSameDelivery` compara
`(consumerName, messageId, payloadHash)`; `markProcessed` é terminal e registra
quando os efeitos foram aplicados. Na redelivery, a aplicação lê o registro
existente e verifica o fingerprint antes de decidir pelo ack.

`OutboxMessage.enqueue` recebe IDs, tipo, data e envelope JSON já serializável.
Não publica eventos. O worker lê somente registros confirmados no banco.
`attempts` conta **falhas de publicação**, não inclui a publicação bem-sucedida.
`scheduleRetry` usa backoff exponencial: 1s, 2s, 4s, até 5min por padrão; permite
política explícita em milissegundos. Só agenda uma nova falha quando o registro
está due. `markPublished` é terminal e limpa o agendamento.

A política padrão não descarta eventos após um número de falhas. O worker deve
monitorar tentativas e lag e permitir recuperação operacional. Retry de referência
ausente e sua política de TTL pertencem ao futuro worker de transações, não à outbox.

## Garantias da persistência

Uma entidade isolada não consegue impedir que outro processo crie uma wallet ou
aplique o mesmo evento. A Fase 2 implementa as constraints, triggers, locks e a
unidade de trabalho abaixo. A Fase 3 conecta esses mecanismos nos casos de uso;
a integração de transporte e os workers de mensageria ficam para as próximas fases:

| Garantia | Mecanismo exigido no PostgreSQL / aplicação |
| --- | --- |
| Uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| Saldo não negativo | `CHECK (balance >= 0)` |
| Sem lost update | Update condicionado à versão originalmente lida, com retry limitado, ou lock por wallet |
| Identidade da transação | `UNIQUE (provider_id, external_transaction_id)` e `UNIQUE (provider_id, idempotency_key)` |
| Um lançamento por transação e wallet | `UNIQUE (wallet_id, transaction_id)` |
| Sem dupla reversão do mesmo tipo | Índice único parcial sobre `(reference_transaction_id, kind)` para reversões `PROCESSED` |
| Redelivery segura | `UNIQUE (consumer_name, message_id)` na inbox |
| Outbox identificável | Chave única do evento em `id` |
| Ledger imutável | Permissões/trigger que impeçam update/delete, além de constraints aritméticas |
| Commit financeiro atômico | Wallet, transação, ledger, inbox e outbox na mesma transação SQL |
| Publishers concorrentes | `FOR UPDATE SKIP LOCKED` durante a transação; rollback/crash libera os locks |

Mesmo com locking, a outbox entrega **at-least-once**: uma queda após publicar e
antes de registrar publicação pode gerar duplicata. Consumidores deduplicam pelo
ID estável do evento. Ack da inbox ocorre apenas após commit. Rejeições não chamam
operações da wallet nem geram ledger. A resposta original, incluindo o saldo
observado, precisa ser persistida pelo use case para replay estável.

## Erros e validação

`DomainError.code` usa `FailureCode`, sem depender de HTTP. A aplicação deve mapear:

- `INVALID_MONEY`, `INVALID_PAYLOAD`: entrada inválida.
- `CURRENCY_MISMATCH`, `INVALID_REFERENCE`, `INSUFFICIENT_FUNDS`,
  `REVERSAL_INSUFFICIENT_FUNDS`, `ALREADY_REVERSED`: violações de negócio.
- `REFERENCE_NOT_FOUND`: referência ausente; manter pendente ou rejeitar após TTL.
- `IDEMPOTENCY_CONFLICT`: identidade/payload conflitante.
- `INVALID_STATE`, `INVALID_LEDGER`: transição indevida ou integridade violada.
- `PERMANENT_INFRASTRUCTURE_FAILURE`: falha permanente auditável.

`ALREADY_REVERSED` é produzido pela aplicação após consultar reversões sob o
lock da wallet. A constraint única continua como defesa; uma corrida detectada
no banco provoca rollback e retry, que refaz essa consulta. Não há queries nem
catálogo global em memória no domínio.

Os testes unitários usam Bun e datas explícitas, sem serviços externos. Cobrem
precisão, normalização, rejeição de arredondamento, invariantes de saldo/versão,
atomicidade em falhas, reidratação, matriz de transições, regras de referências,
conflitos de idempotência, ledger, isolamento de objetos mutáveis e retries.
Os testes em `tests/integration` verificam migrations, integridade SQL, atomicidade
entre repositórios, concorrência em débitos e claims de outbox em PostgreSQL real.
Eles não substituem os futuros testes ponta a ponta com API e mensageria.
