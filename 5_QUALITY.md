# Fase 7 — contratos, documentação e qualidade contínua

## Desenvolvimento e commits

Execute `bun install --frozen-lockfile`. O script `prepare` instala os hooks Husky
somente em um checkout Git local; CI e imagens Docker não precisam de hooks.
O desenvolvimento, runtime e scripts de qualidade usam Bun. O CI também instala
Node 24 para as ferramentas de terceiros e actions que dependem dele.

```sh
bun run format
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
```

O ESLint usa `eslint.config.js` (flat config ESM), substituindo `.eslintrc.js`.
A análise de tipos proíbe `any`, operações inseguras, promises esquecidas, imports
e variáveis sem uso e código inalcançável. Os imports são ordenados automaticamente.
Mocks e migrations que enfileiram SQL implementam interfaces assíncronas sem
`await`; essa exceção fica restrita a esses arquivos. A regra `await-thenable` é
desabilitada nos testes porque os tipos dos matchers Bun 1.3 não representam as
promises de `resolves/rejects`; essas assertions continuam aguardadas.
TypeScript mantém `strict`, `noUnusedLocals`,
`noUnusedParameters`, `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes`.
Prettier, EditorConfig e Git adotam UTF-8, LF, dois espaços e aspas simples.

O `pre-commit` executa ESLint com autofix e Prettier apenas nos arquivos staged;
lint-staged gerencia alterações parcialmente staged. O `commit-msg` valida
Conventional Commits, por exemplo `feat(api): document transaction submission`
ou `fix(messaging): reject malformed deliveries`. Os mesmos checks rodam no CI,
pois hooks locais podem ser ignorados. `bun run prepare` reinstala os hooks.

## Contratos Zod

Os contratos executáveis estão em `src/infrastructure/validation/contracts.ts`.
`CreateWalletDto`, `SubmitTransactionDto` e `SqsWagerDto` são inferidos dos schemas,
evitando manter interfaces separadas. Exemplo:

```ts
const input = createWalletSchema.parse(await request.json());
const money = Money.from(input.initialBalance);
```

HTTP e SQS rejeitam campos extras, dinheiro numérico, casas decimais além de duas,
moedas fora do formato ISO de três letras maiúsculas e identificadores inválidos.
IDs externos são opacos, de 1–128 caracteres (`A-Z`, `a-z`, dígitos, `_ . : @ / -`);
IDs internos em URLs são UUIDs. A borda limita valores a 18 dígitos inteiros,
sem conversão financeira para ponto flutuante; o domínio e o PostgreSQL continuam
usando dinheiro exato (`bigint` em centavos e `numeric` sem precisão fixa).
As regras de saldo, positividade, referência e transição permanecem no domínio.

HTTP recebe `Idempotency-Key` exclusivamente no header; `correlationId` vem do
header `X-Correlation-Id`, normalizado ou gerado pelo servidor. O body não aceita
`idempotencyKey`, `correlationId` ou `delivery`. A paginação valida limites, cursor,
wallet do cursor e parâmetros repetidos. Reconciliação aceita corpo vazio ou `{}`.

SQS usa o mesmo contrato financeiro, acrescido de `idempotencyKey` obrigatório e
`correlationId` opcional. `decodeWager` valida antes do caso de uso e sempre usa
MessageId do transporte. Payload inválido é falha permanente: o consumidor grava
a disposição, encaminha à DLQ e só então confirma a mensagem, preservando o fluxo
durável anterior. O consumidor da DLQ arquiva dados inválidos sem executá-los.
Erros de validação retornam apenas `INVALID_PAYLOAD`, sem valores ou detalhes sensíveis.

## Swagger interativo

Com a API iniciada, abra <http://localhost:3000/docs>; o documento está em
<http://localhost:3000/docs-json>. O servidor HTTP agora usa controllers Nest com
adapter Express executado em Bun. Eles delegam à mesma fronteira `Api` usada nos
testes e ferramentas, preservando transações e idempotência. Workers continuam
usando seu listener Bun operacional. O limite HTTP permanece em 64 KiB.

1. Execute `POST /wallets` com o exemplo fornecido e copie o `id` retornado.
2. Em `POST /wagering/transactions`, informe esse `walletId`, o mesmo `playerId`
   e o header obrigatório `Idempotency-Key` no campo próprio do Swagger.
3. Repita a submissão com body e chave idênticos para observar `idempotentReplay`.
4. Consulte transação, saldo, ledger e reconciliação pelos endpoints documentados.

Os schemas de request OpenAPI são gerados dos mesmos schemas Zod, com
`additionalProperties: false`. Decorators documentam headers, parâmetros,
exemplos, respostas e falhas. `/health` é um alias de readiness; `/health/live`,
`/health/ready` e `/metrics` também estão documentados. A autenticação de provider
continua no-op conforme a arquitetura; a documentação não simula um JWT funcional.

## Pino e privacidade

`LoggingModule` registra `nestjs-pino`; os bootstraps substituem o logger Nest
com `app.useLogger(app.get(Logger))`. O logger de eventos usa a mesma instância Pino.
`AsyncLocalStorage` mantém os IDs de HTTP, SQS, outbox e reprocessamentos, isolados
entre operações concorrentes. Todo registro contém `correlationId`, `messageId`,
`transactionId`, `walletId` e `providerId`, com `null` quando indisponíveis.

A projeção do Pino permite apenas eventos e metadados operacionais. Serializers
descartam request, response e erro bruto; redaction protege campos financeiros e
credenciais como defesa adicional. Mensagens arbitrárias do framework viram
`framework_log`, sem stack/SQL/strings de conexão. A conclusão HTTP é emitida uma
vez, pelo handler, após conhecer os IDs da transação. Logs JSON vão para stdout.

## GitHub Actions e SonarCloud

`.github/workflows/quality.yml` instala o lockfile, verifica formato, lint, tipos e
commits de PR, sobe PostgreSQL/LocalStack e executa todos os testes com LCOV.
`test:ci` exige as duas variáveis TEST_*: não aceita integração inteiramente skipped.
`coverage/lcov.info` é enviado como artifact e consumido pelo SonarCloud.

No repositório GitHub, configure:

| Tipo     | Nome                 | Conteúdo                                  |
| -------- | -------------------- | ----------------------------------------- |
| Secret   | `SONAR_TOKEN`        | Token com permissão de análise no projeto |
| Variable | `SONAR_ORGANIZATION` | Chave da organização SonarCloud           |
| Variable | `SONAR_PROJECT_KEY`  | Chave do projeto SonarCloud               |

Importe o repositório no SonarCloud e desative Automatic Analysis para usar a
análise via CI. As chaves são fornecidas ao scanner por argumentos; nenhum token
é versionado. `sonar-project.properties` define fontes, testes, LCOV e espera do
Quality Gate. Migrations versionadas ficam fora apenas da métrica de cobertura;
todo o `src` permanece na análise estática. Duplicações, problemas e dívida técnica usam o Quality Profile
do projeto. Configure o Quality Gate no SonarCloud e torne o job `quality` obrigatório
na proteção da branch. Nenhuma configuração remota é alterada por estes arquivos.

PRs de forks executam os checks e testes sem receber segredos; a análise Sonar é
pulada nesses PRs. PRs internos e pushes falham explicitamente se faltar configuração
Sonar. Não se usa `pull_request_target` para executar código não confiável com token.

Referências: [Swagger NestJS](https://docs.nestjs.com/openapi/introduction),
[nestjs-pino](https://github.com/iamolegga/nestjs-pino),
[Zod JSON Schema](https://zod.dev/json-schema),
[typescript-eslint](https://typescript-eslint.io/users/configs/),
[Husky](https://typicode.github.io/husky/how-to.html) e
[SonarCloud no GitHub Actions](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/github-actions-for-sonarcloud/).

## Verificação da implementação

Validado em 11/11/2026: formato, ESLint sem warnings e TypeScript aprovados.
O comando `test:ci` executou 237 testes com zero falhas no Bun 1.3.2, PostgreSQL 17
e LocalStack 4.10.0, incluindo concorrência, crashes, Swagger, HTTP real e SQS.
LCOV foi gerado em `coverage/lcov.info`. Após o ajuste final da resposta HTTP 413,
os nove testes de HTTP/observabilidade também passaram. Os hooks foram executados
em um repositório temporário: pre-commit formatou o arquivo staged, commit-msg
aceitou Conventional Commits e rejeitou uma mensagem inválida.

Logs locais: `reports/phase7-ci.log` e `reports/phase7-http.log` (ignorados pelo Git).
A análise remota do SonarCloud depende das três configurações acima e não foi
executada localmente.
