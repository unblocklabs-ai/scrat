let generation = 0;
const waiters = new Set<() => void>();

export function workGeneration() {
  return generation;
}

export function signalWork() {
  generation++;
  for (const wake of [...waiters]) wake();
}

export function waitForWork(since: number, timeoutMs: number, signal?: AbortSignal) {
  if (signal?.aborted || generation !== since) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", wake);
      waiters.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, timeoutMs);
    signal?.addEventListener("abort", wake, { once: true });
    waiters.add(wake);
  });
}
