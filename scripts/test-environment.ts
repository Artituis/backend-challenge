import { mkdir } from 'node:fs/promises';

const mode = process.argv[2] ?? 'integration';
if (!['integration', 'load'].includes(mode)) throw new Error('Expected integration or load');
const target = mode === 'load' ? ['scripts/load.ts'] : ['scripts/integration.ts'];
const database = process.env['TEST_DATABASE_URL'];
const sqs = process.env['TEST_SQS_ENDPOINT'];
if (Boolean(database) !== Boolean(sqs)) throw new Error('Set both TEST_DATABASE_URL and TEST_SQS_ENDPOINT, or neither');
if (database && sqs) {
  const child = Bun.spawn([process.execPath, ...target], { stdout: 'inherit', stderr: 'inherit' });
  process.exit(await child.exited);
}
await mkdir('reports', { recursive: true });
const project = `wagering-qa-${process.pid}-${Date.now()}`;
const prefix = ['docker', 'compose', '-f', 'compose.test.yaml', '-p', project];
async function compose(args: string[]): Promise<void> {
  const child = Bun.spawn([...prefix, ...args], { stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Docker Compose ${args[0]} exited ${code}`);
}
try {
  await compose(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres', 'localstack']);
  await compose(['run', '--build', '--rm', '--no-deps', 'runner', 'bun', ...target]);
} catch (error) {
  await compose(['logs', '--tail', '100', 'postgres', 'localstack']).catch(() => undefined);
  throw error;
} finally {
  await compose(['down', '--volumes', '--remove-orphans']);
}
