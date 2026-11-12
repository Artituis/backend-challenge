// Containers and CI do not install Git hooks; local installs do.
if (
  process.env['HUSKY'] !== '0' &&
  !process.env['CI'] &&
  (await Bun.file('.git/config').exists())
) {
  const child = Bun.spawn([process.execPath, 'node_modules/husky/bin.js'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exitCode = await child.exited;
}
export {};
