import { spawn as nodeSpawn } from "node:child_process";

const TITLE_LIMIT = 120;
const BODY_LIMIT = 240;
const REASONS = {
  idle: "Response complete",
  question: "Question requires attention",
  permission: "Permission requires attention",
  error: "Error requires attention",
};

const truncate = (text, limit) => text.length <= limit
  ? text
  : `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;

export const sanitizeNotificationText = (value, limit) => {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return truncate(text, limit);
};

export const buildNotification = ({ workspaceId, workspaceTitle, stageId, stageTitle, reason } = {}) => {
  if (!/^\d{6}$/.test(workspaceId) || !/^\d{2}$/.test(stageId) || !REASONS[reason]) return null;
  const safeWorkspace = sanitizeNotificationText(workspaceTitle, 80);
  const safeStage = sanitizeNotificationText(stageTitle, 100);
  if (!safeWorkspace || !safeStage) return null;
  return {
    title: truncate(`Work Context ${workspaceId}: ${safeWorkspace}`, TITLE_LIMIT),
    body: truncate(`Stage ${stageId}: ${safeStage}. ${REASONS[reason]}.`, BODY_LIMIT),
  };
};

export const notifySendArguments = (notification, actionable = false, expireTimeMs = 0) => [
  "--app-name=OpenCode Work Context",
  "--urgency=normal",
  ...(actionable ? ["--action=default=Open session", `--expire-time=${expireTimeMs}`] : []),
  "--",
  notification.title,
  notification.body,
];

export const createDesktopNotifier = ({
  enabled = true,
  platform = process.platform,
  spawn = nodeSpawn,
  timeoutMs = 3000,
  actionTimeoutMs = 5 * 60 * 1000,
} = {}) => {
  const children = new Map();
  let disposed = false;
  const send = (notification, { onOpen, actionable }) => new Promise((resolve) => {
    let child;
    let output = "";
    let timer;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child) children.delete(child);
      resolve(result);
    };
    try {
      child = spawn("notify-send", notifySendArguments(notification, actionable, actionTimeoutMs), {
        shell: false,
        stdio: actionable ? ["ignore", "pipe", "ignore"] : "ignore",
        windowsHide: true,
      });
      children.set(child, finish);
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        const remaining = 32 - output.length;
        output += text.slice(0, Math.max(0, remaining));
        if (text.length > remaining) {
          try { child.kill(); } catch {}
          finish({ delivered: false, retry: false });
        }
      });
      child.stdout?.once("error", () => finish({ delivered: false, retry: false }));
      child.once("error", () => finish({ delivered: false, retry: false }));
      child.once("exit", (code) => {
        if (settled) return;
        if (code === 0 && actionable && output.trim() === "default") {
          try { void Promise.resolve(onOpen()).catch(() => {}); } catch {}
        }
        finish({ delivered: code === 0, retry: actionable && code !== 0 });
      });
      timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ delivered: false, retry: false });
      }, actionable ? actionTimeoutMs + 1000 : timeoutMs);
      timer.unref?.();
    } catch {
      finish({ delivered: false, retry: false });
    }
  });
  const notify = async (context, { onOpen } = {}) => {
    const notification = buildNotification(context);
    if (disposed || !enabled || platform !== "linux" || !notification) return false;
    const actionable = typeof onOpen === "function";
    const result = await send(notification, { onOpen, actionable });
    if (result.retry && !disposed) return (await send(notification, { actionable: false })).delivered;
    return result.delivered;
  };
  return {
    notify,
    dispose: () => {
      disposed = true;
      for (const [child, finish] of children) {
        try { child.kill(); } catch {}
        finish({ delivered: false, retry: false });
      }
      children.clear();
    },
  };
};
