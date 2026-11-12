export {};
// Fail closed: explicitly running integration must never succeed by skipping every test.
if (!process.env['TEST_DATABASE_URL'] || !process.env['TEST_SQS_ENDPOINT']) {
  throw new Error(
    'Integration requires TEST_DATABASE_URL and TEST_SQS_ENDPOINT; use bun run test:integration for Docker setup',
  );
}
const check = Bun.spawn([process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit'], {
  stdout: 'inherit',
  stderr: 'inherit',
});
if ((await check.exited) !== 0) process.exit(1);
const tests = Bun.spawn(
  [process.execPath, 'test', '--timeout', '30000', ...process.argv.slice(2)],
  { stdout: 'inherit', stderr: 'inherit' },
);
process.exit(await tests.exited);
