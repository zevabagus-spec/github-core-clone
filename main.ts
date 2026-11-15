// Entry point. The forge binds an ephemeral port, registers it with the
// harness, and serves until the harness reports the run is done.
//
//   MAKEFUN_ENV_URL    base URL of the harness (required)
//   MAKEFUN_SHOP_TOKEN bearer token every API call carries
//
// Lifecycle, per the kit's wire contract: listen on port 0, POST
// {"port": N} to $MAKEFUN_ENV_URL/register (first registration wins;
// 400/405 are fatal, anything else is retried with backoff), then poll
// GET $MAKEFUN_ENV_URL/done until {"done": true}, close the server and
// exit 0. Exit 1 at once when MAKEFUN_ENV_URL is unset.

import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let json: unknown = null;
    const text = await response.text();
    if (text !== '') {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function register(envUrl: string, port: number): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const { status } = await fetchJson(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (status >= 200 && status < 300) return;
      if (status === 409) return; // First registration wins; ours is late.
      if (status === 400 || status === 405) {
        throw new Error(`registration rejected with status ${status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('registration rejected')) throw err;
      // Anything else (network, timeout, 5xx): retry with backoff.
    }
    await sleep(delay);
    delay = Math.min(2000, delay * 2);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const { status, json } = await fetchJson(`${envUrl}/done`);
      if (status >= 200 && status < 300) {
        const done = (json as { done?: unknown } | null)?.done;
        if (done === true) return;
      }
    } catch {
      // Poll failures are retried; the harness answers at once when done.
    }
    await sleep(delay);
    delay = Math.min(2000, delay * 2);
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    process.stderr.write('forge: MAKEFUN_ENV_URL is not set\n');
    process.exit(1);
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN;

  const { server } = createApp({ token });
  // The suite's read workload reuses one keep-alive connection for 2,000
  // requests; a long keep-alive timeout keeps that socket warm across the
  // suite's phases on a loaded pod instead of dropping it mid-benchmark.
  server.keepAliveTimeout = 120_000;
  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectPromise(new Error('server did not bind to a port'));
        return;
      }
      resolvePromise(address.port);
    });
  });

  await register(envUrl, port);
  await waitForDone(envUrl);

  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  });
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`forge: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
