export function sameFilePath(a, b) {
  if (!a || !b) return false;
  const normalize = value => String(value)
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/g, '')
    .toLowerCase();
  return normalize(a) === normalize(b);
}

export function createSingleFlight() {
  let active = null;
  return {
    run(task) {
      if (active) return active;
      const operation = Promise.resolve().then(task);
      const wrapped = operation.finally(() => {
        if (active === wrapped) active = null;
      });
      active = wrapped;
      return wrapped;
    },
    isActive() {
      return !!active;
    },
  };
}

export function createAsyncQueue() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const operation = tail.catch(() => {}).then(task);
      tail = operation;
      return operation;
    },
  };
}

export async function promiseWithTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true, value: undefined }), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve(promise).then(value => ({ timedOut: false, value })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
