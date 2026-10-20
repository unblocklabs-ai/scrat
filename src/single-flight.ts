// Runs `work` after any earlier work under the same key settles; an earlier failure never blocks it.
export async function serialized<T>(locks: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>) {
  const previous = locks.get(key);
  const pending = (async () => {
    if (previous) await previous.catch(() => {});
    return work();
  })();
  locks.set(key, pending);
  try { return await pending; }
  finally { if (locks.get(key) === pending) locks.delete(key); }
}
