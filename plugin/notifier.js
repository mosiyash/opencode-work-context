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

export const notifySendArguments = (notification) => [
  "--app-name=OpenCode Work Context",
  "--urgency=normal",
  "--",
  notification.title,
  notification.body,
];

export const createDesktopNotifier = ({
  enabled = true,
  platform = process.platform,
  spawn = nodeSpawn,
  timeoutMs = 3000,
} = {}) => ({
  async notify(context) {
    const notification = buildNotification(context);
    if (!enabled || platform !== "linux" || !notification) return false;
    return new Promise((resolve) => {
      let child;
      let timer;
      let settled = false;
      const finish = (delivered) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(delivered);
      };
      try {
        child = spawn("notify-send", notifySendArguments(notification), {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
        child.once("error", () => finish(false));
        child.once("exit", (code) => finish(code === 0));
        timer = setTimeout(() => {
          try { child.kill(); } catch {}
          finish(false);
        }, timeoutMs);
        timer.unref?.();
      } catch {
        finish(false);
      }
    });
  },
});
