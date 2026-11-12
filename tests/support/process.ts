export function startProcess(file: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, file], { env, stdout: 'pipe', stderr: 'pipe' });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  return {
    child,
    async ready(marker: string, timeoutMs = 15_000): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            let output = '';
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done)
                throw new Error(`Process exited before ${marker}: ${output} ${await stderr}`);
              output += new TextDecoder().decode(chunk.value);
              if (output.includes(marker)) return;
            }
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timeout: ${marker}`)), timeoutMs);
          }),
        ]);
        // Drain ongoing logs so stdout backpressure cannot stall the worker.
        void (async () => {
          while (!(await reader.read()).done) {
            /* drain */
          }
        })().catch(() => undefined);
      } finally {
        clearTimeout(timer);
      }
    },
    async kill(): Promise<void> {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      await stderr;
    },
  };
}
