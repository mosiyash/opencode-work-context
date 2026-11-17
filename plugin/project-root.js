const PATH_TIMEOUT_MS = 5000;
const PATH_POLL_MS = 25;
const usableDirectory = (value) => typeof value === "string" && value && value !== "/";

const sleep = (milliseconds, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  const onAbort = () => { clearTimeout(timer); resolve(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal) setTimeout(() => signal.removeEventListener("abort", onAbort), milliseconds);
});

const locationWithDeadline = (api, timeoutMs, signal) => new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolve(value);
  };
  const timer = setTimeout(() => finish(null), timeoutMs);
  const onAbort = () => finish(null);
  signal?.addEventListener("abort", onAbort, { once: true });
  Promise.resolve().then(() => api.client.location.get({})).then(finish, () => finish(null));
});

export const resolveProjectRoot = async (api, { timeoutMs = PATH_TIMEOUT_MS, pollMs = PATH_POLL_MS } = {}) => {
  const directory = api?.state?.path?.directory;
  if (!usableDirectory(api?.state?.path?.worktree) && usableDirectory(directory)) return directory;
  if (!api?.state?.path && !api?.client?.location?.get) return null;
  const signal = api?.lifecycle?.signal;
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted && Date.now() <= deadline) {
    const worktree = api?.state?.path?.worktree;
    if (usableDirectory(worktree)) return worktree;
    if (usableDirectory(directory)) return directory;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const location = await locationWithDeadline(api, remaining, signal);
    const locationDirectory = location?.data?.directory || location?.data?.project?.directory;
    if (usableDirectory(locationDirectory)) return locationDirectory;
    await sleep(pollMs, signal);
  }
  return null;
};

export const withProjectRoot = (api, projectRoot) => projectRoot
  ? Object.assign(Object.create(api), { state: { ...api.state, path: { ...api.state?.path, directory: projectRoot, worktree: projectRoot } } })
  : api;
