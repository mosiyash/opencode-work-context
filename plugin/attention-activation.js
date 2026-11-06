import { spawn as nodeSpawn } from "node:child_process";

const WINDOW_ID = /^0x[0-9a-f]+$/i;
const MAX_OUTPUT = 128;

const run = ({ executable, args, spawn, timeoutMs, capture = false, children }) => new Promise((resolve) => {
  let child;
  let output = "";
  let timer;
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (child) children?.delete(child);
    resolve(result);
  };
  try {
    child = spawn(executable, args, {
      shell: false,
      stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
      windowsHide: true,
    });
    children?.set(child, finish);
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      const remaining = MAX_OUTPUT - output.length;
      output += text.slice(0, Math.max(0, remaining));
      if (text.length > remaining) {
        try { child.kill(); } catch {}
        finish({ ok: false, output: "" });
      }
    });
    child.stdout?.once("error", () => finish({ ok: false, output: "" }));
    child.once("error", () => finish({ ok: false, output: "" }));
    child.once("exit", (code) => finish({ ok: code === 0, output }));
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, output: "" });
    }, timeoutMs);
    timer.unref?.();
  } catch {
    finish({ ok: false, output: "" });
  }
});

const normalizeWindowId = (value) => {
  const text = String(value ?? "").trim();
  if (WINDOW_ID.test(text)) return text === "0x0" ? null : text;
  if (/^\d+$/.test(text)) {
    try {
      const normalized = `0x${BigInt(text).toString(16)}`;
      return normalized === "0x0" ? null : normalized;
    } catch {}
  }
  return null;
};

export const parseActiveWindowId = (output) => {
  const match = String(output ?? "").match(/0x[0-9a-f]+/i);
  return normalizeWindowId(match?.[0]);
};

export const createAttentionActivator = ({
  api,
  env = process.env,
  platform = process.platform,
  spawn = nodeSpawn,
  timeoutMs = 1000,
  captureThrottleMs = 1000,
  navigationTimeoutMs = 2000,
  now = () => Date.now(),
} = {}) => {
  const paneId = env.TMUX && /^%\d+$/.test(env.TMUX_PANE || "") ? env.TMUX_PANE : null;
  const canCaptureWindow = platform === "linux" && Boolean(env.DISPLAY);
  let windowId = null;
  let lastCapture = 0;
  let capturePending;
  let disposed = false;
  let focused = false;
  let captureGeneration = 0;
  const children = new Map();

  const capture = () => {
    if (disposed || !canCaptureWindow) return Promise.resolve(windowId);
    focused = true;
    const timestamp = now();
    if (capturePending) return capturePending;
    if (lastCapture && timestamp - lastCapture < captureThrottleMs) return Promise.resolve(windowId);
    lastCapture = timestamp;
    const generation = captureGeneration;
    capturePending = run({ executable: "xprop", args: ["-root", "_NET_ACTIVE_WINDOW"], spawn, timeoutMs, capture: true, children })
      .then((result) => {
        const captured = result.ok ? parseActiveWindowId(result.output) : null;
        if (!disposed && focused && generation === captureGeneration && captured) windowId = captured;
        return windowId;
      })
      .finally(() => { capturePending = undefined; });
    return capturePending;
  };

  const blur = () => {
    focused = false;
    captureGeneration += 1;
  };

  const navigate = async (sessionId) => {
    if (typeof api?.route?.navigate !== "function") return false;
    let navigation;
    try { navigation = Promise.resolve(api.route.navigate("session", { sessionID: sessionId })); } catch { return false; }
    let timer;
    try {
      return await Promise.race([
        navigation.then(() => true, () => false),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), navigationTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const activate = async (sessionId) => {
    if (disposed || typeof sessionId !== "string" || !sessionId || sessionId.length > 256) return false;
    let activated = await navigate(sessionId);
    if (disposed) return activated;
    if (paneId) {
      const selectedWindow = await run({ executable: "tmux", args: ["select-window", "-t", paneId], spawn, timeoutMs, children });
      if (disposed) return activated;
      const selectedPane = await run({ executable: "tmux", args: ["select-pane", "-t", paneId], spawn, timeoutMs, children });
      activated = selectedWindow.ok && selectedPane.ok || activated;
    }
    if (disposed) return activated;
    if (windowId && canCaptureWindow) {
      const raised = await run({ executable: "wmctrl", args: ["-ia", windowId], spawn, timeoutMs, children });
      activated = raised.ok || activated;
    }
    return activated;
  };

  return {
    available: typeof api?.route?.navigate === "function" || Boolean(paneId) || Boolean(windowId),
    capture,
    blur,
    activate,
    target: () => ({ paneId, windowId }),
    dispose: () => {
      disposed = true;
      blur();
      for (const [child, finish] of children) {
        try { child.kill(); } catch {}
        finish({ ok: false, output: "" });
      }
      children.clear();
    },
  };
};
