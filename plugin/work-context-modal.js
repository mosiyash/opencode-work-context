import fs from "node:fs";
import path from "node:path";
import { readWorkContextSnapshot } from "../src/work-context-snapshot.js";
import { normalizeStageId, normalizeWorkspaceId } from "../src/identifiers.js";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal } from "solid-js";
import { openStageSwitcher } from "./stage-switcher.js";
import { openWorkspaceSwitcher } from "./workspace-switcher.js";
import { openSessionSwitcher } from "./session-switcher.js";

const COMMAND_NAME = "work_context.open";
const ACTIONS_COMMAND_NAME = "work_context.actions";
const SHORTCUT = "<leader>w";
const STAGE_SHORTCUT = "<leader>s";
const WORKSPACE_SHORTCUT = "<leader>o";
const SESSION_SHORTCUT = "<leader>e";
const DEBOUNCE_MS = 150;
const POLL_MS = 1000;
const MARKERS = { planned: "[ ]", in_progress: "[•]", completed: "[✓]", cancelled: "[!]" };
const COMMANDS = { list: "list", resume: "resume", handoff: "stage handoff", finish: "stage finish" };
const activeTuiInstances = new WeakMap();

export const WORK_CONTEXT_ACTIONS = [
  { value: "help", title: "Help", description: "Show work-context command help", category: "General" },
  { value: "switch.stage", title: "Switch stage", description: "Open a stage session in the current workspace", footer: "ctrl+alt+w s", category: "Navigation" },
  { value: "switch.workspace", title: "Switch workspace", description: "Open a workspace session", footer: "ctrl+alt+w o", category: "Navigation" },
  { value: "switch.session", title: "Switch session", description: "Open an active or historical work session", footer: "ctrl+alt+w e", category: "Navigation" },
  { value: "list", title: "Browse workspaces", description: "Search workspaces and their stages", category: "General" },
  { value: "browse.stages", title: "Browse stages", description: "Search stages across every workspace", category: "General" },
  { value: "browse.sessions", title: "Browse sessions", description: "Search active and historical work sessions", category: "General" },
  { value: "create", title: "Create workspace", description: "Create a workspace from a title", category: "Workspace" },
  { value: "workspace.list", title: "Inspect workspace", description: "List one workspace and its stages", category: "Workspace" },
  { value: "workspace.rename", title: "Rename workspace", description: "Change a workspace title", category: "Workspace" },
  { value: "workspace.finish", title: "Finish workspace", description: "Complete a workspace", category: "Workspace" },
  { value: "stage.add", title: "Add stage", description: "Create a planned stage with an optional prompt", category: "Stage" },
  { value: "resume", title: "Resume stage", description: "Start or continue work on a stage", category: "Stage" },
  { value: "stage.rename", title: "Rename stage", description: "Change a stage title", category: "Stage" },
  { value: "stage.update", title: "Update stage description", description: "Replace a stage description", category: "Stage" },
  { value: "stage.update-prompt", title: "Update stage prompt", description: "Replace the detailed working prompt", category: "Stage" },
  { value: "stage.update-result", title: "Update stage result", description: "Replace an existing completion result", category: "Stage" },
  { value: "stage.archive", title: "Archive stage", description: "Archive a non-active stage", category: "Stage" },
  { value: "stage.handoff", title: "Hand off stage", description: "Close this session and preserve continuation", category: "Stage" },
  { value: "stage.abandon", title: "Abandon stage session", description: "Close this session and keep the stage resumable", category: "Stage" },
  { value: "stage.finish", title: "Finish stage", description: "Complete a stage and review knowledge", category: "Stage" },
  { value: "session.rename", title: "Rename work session", description: "Change the current work-context session summary", category: "Session" },
];

const disposeRegistration = (registration) => {
  if (typeof registration === "function") registration();
  else registration?.dispose?.();
};

const closeDialog = (api) => api?.ui?.dialog?.clear?.();
const textOf = (value) => String(value || "").toLocaleLowerCase();
const matches = (value, query) => !query || textOf(value).includes(textOf(query));

const normalizedId = (normalize, value) => {
  try { return normalize(value); } catch { return null; }
};

/** Prepare a canonical command without parsing or executing it. */
export const prepareWorkContextCommand = (action, workspace, stage) => {
  const normalizedWorkspace = normalizedId(normalizeWorkspaceId, workspace);
  if (!normalizedWorkspace) return { ok: false, error: { code: "INVALID_ARGUMENT", message: "Invalid workspace ID" } };
  if (!Object.hasOwn(COMMANDS, action)) return { ok: false, error: { code: "INVALID_ARGUMENT", message: "Unsupported work-context command" } };
  if (action === "list") return { ok: true, command: `/wc workspace list ${normalizedWorkspace}` };
  const normalizedStage = normalizedId(normalizeStageId, stage);
  if (!normalizedStage) return { ok: false, error: { code: "INVALID_ARGUMENT", message: "Invalid stage ID" } };
  return { ok: true, command: `/wc ${COMMANDS[action]} ${normalizedWorkspace} ${normalizedStage}` };
};

/** Use only a host-provided prompt append bridge; never submit the prompt. */
export const insertPromptCommand = (api, command) => {
  if (typeof command !== "string" || !command.startsWith("/wc ")) return { ok: false, error: { code: "INVALID_ARGUMENT", message: "Invalid prepared command" } };
  const append = api?.ui?.prompt?.append || api?.prompt?.append;
  if (typeof append !== "function") return { ok: false, command, error: { code: "PROMPT_INSERT_UNAVAILABLE", message: "Prompt insertion is unavailable; submit this command manually." } };
  try { append(command); } catch (error) {
    return { ok: false, command, error: { code: error.code || "PROMPT_INSERT_ERROR", message: error.message || "Prompt insertion failed; submit this command manually." } };
  }
  return { ok: true, command, submitted: false };
};

/** Append through the public TUI endpoint; keep compatibility bridges as a fallback. */
export const appendPromptCommand = async (api, command) => {
  if (typeof command !== "string" || !command.startsWith("/wc ")) return { ok: false, error: { code: "INVALID_ARGUMENT", message: "Invalid prepared command" } };
  if (typeof api?.client?.tui?.appendPrompt === "function") {
    try {
      await api.client.tui.appendPrompt({ directory: api.state?.path?.directory || api.state?.path?.worktree, text: command }, { throwOnError: true });
      return { ok: true, command, submitted: false };
    } catch (error) {
      return { ok: false, command, error: { code: error.code || "PROMPT_INSERT_ERROR", message: error.message || "Prompt insertion failed" } };
    }
  }
  return insertPromptCommand(api, command);
};

export const quoteWorkContextArgument = (value) => JSON.stringify(String(value));

export const filterWorkspaces = (workspaces = [], query = "") => workspaces
  .map((workspace) => ({
    ...workspace,
    stages: (workspace.stages || []).filter((stage) => matches(`${stage.id} ${stage.title} ${stage.description}`, query)),
  }))
  .filter((workspace) => matches(`${workspace.id} ${workspace.title} ${workspace.status}`, query) || workspace.stages.length);

export const createWorkContextModalController = ({
  projectRoot,
  sessionId,
  read = readWorkContextSnapshot,
  debounceMs = DEBOUNCE_MS,
  pollMs = POLL_MS,
  createSignal: makeSignal = createSignal,
  onClose = () => {},
  onCommand = () => {},
} = {}) => {
  const [version, setVersion] = makeSignal(0);
  const [query, setQuery] = makeSignal("");
  const [workspaceIndex, setWorkspaceIndex] = makeSignal(0);
  const [stageIndex, setStageIndex] = makeSignal(0);
  const [details, setDetails] = makeSignal(false);
  let result = null;
  let successful = null;
  let timer;
  let poller;
  let disposed = false;
  let onSelectionChange = () => {};

  const refresh = async () => {
    if (disposed) return;
    try {
      const next = await read({ projectRoot, sessionId });
      if (disposed) return;
      if (next?.ok) { successful = next; result = next; }
      else result = successful ? { ...successful, stale: true, error: next?.error || { code: "STORAGE_ERROR" } } : next;
    } catch (error) {
      if (disposed) return;
      result = successful
        ? { ...successful, stale: true, error: { code: error.code || "STORAGE_ERROR", message: error.message } }
        : { ok: false, error: { code: error.code || "STORAGE_ERROR", message: error.message } };
    }
    setVersion((value) => value + 1);
  };
  const scheduleRefresh = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void refresh(); }, debounceMs);
  };
  const snapshot = () => { version(); return result; };
  const workspaces = () => filterWorkspaces(snapshot()?.data?.workspaces || [], query());
  const selectedWorkspace = () => workspaces()[Math.min(workspaceIndex(), Math.max(0, workspaces().length - 1))] || null;
  const selectedStage = () => selectedWorkspace()?.stages?.[Math.min(stageIndex(), Math.max(0, (selectedWorkspace()?.stages || []).length - 1))] || null;
  const [preparedCommand, setPreparedCommand] = makeSignal(null);
  const prepareCommand = (action) => {
    const workspace = selectedWorkspace()?.id;
    const stage = selectedStage()?.id;
    const prepared = prepareWorkContextCommand(action, workspace, stage);
    setPreparedCommand(prepared);
    return prepared;
  };
  const insertCommand = (action) => {
    const prepared = prepareCommand(action);
    if (!prepared.ok) return prepared;
    const inserted = onCommand(prepared.command);
    const result = inserted && typeof inserted === "object" ? { ...prepared, ...inserted } : prepared;
    setPreparedCommand(result);
    return result;
  };
  const moveWorkspace = (delta) => {
    const count = workspaces().length;
    if (count) setWorkspaceIndex(Math.max(0, Math.min(count - 1, workspaceIndex() + delta)));
    setStageIndex(0);
  };
  const moveStage = (delta) => {
    const count = selectedWorkspace()?.stages?.length || 0;
    if (count) setStageIndex(Math.max(0, Math.min(count - 1, stageIndex() + delta)));
  };
  const handleKey = (event) => {
    const rawKey = typeof event === "string" ? event : event?.key || event?.name;
    const key = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Escape: "escape" })[rawKey] || rawKey;
    if (key === "up") moveWorkspace(-1);
    else if (key === "down") moveWorkspace(1);
    else if (key === "left") moveStage(-1);
    else if (key === "right") moveStage(1);
    else if (key === "Enter") setDetails((value) => !value);
    else if (key === "d") setDetails((value) => !value);
    else if (key === "l") insertCommand("list");
    else if (key === "r") insertCommand("resume");
    else if (key === "h") insertCommand("handoff");
    else if (key === "f") insertCommand("finish");
    else if (key === "Backspace") setQuery(query().slice(0, -1));
    else if (key === "escape") { if (query()) setQuery(""); else onClose(); }
    else if (key === "/") setQuery("");
    else if (typeof key === "string" && key.length === 1 && !event?.ctrlKey && !event?.metaKey) setQuery(query() + key);
    setVersion((value) => value + 1);
    onSelectionChange();
  };
  void refresh();
  if (pollMs) poller = setInterval(scheduleRefresh, pollMs);
  return {
    snapshot, query, setQuery, workspaces, selectedWorkspace, selectedStage, details, preparedCommand, prepareCommand, insertCommand, handleKey, scheduleRefresh,
    onSelectionChange: (handler) => { onSelectionChange = typeof handler === "function" ? handler : () => {}; },
    dispose: () => { disposed = true; clearTimeout(timer); clearInterval(poller); },
  };
};

const line = (runtime, children, props = {}) => runtime.jsx("text", { ...props, children });
const marker = (status) => MARKERS[status] || "[?]";

export const renderWorkContextModal = (controller, theme, runtime = { jsx }, { maxListHeight = 24 } = {}) => {
  let workspaceScroll;
  let stageScroll;
  controller.onSelectionChange?.(() => queueMicrotask(() => {
    try { workspaceScroll?.scrollChildIntoView?.(`workspace-${controller.selectedWorkspace()?.id}`); } catch {}
    try { stageScroll?.scrollChildIntoView?.(`stage-${controller.selectedStage()?.id}`); } catch {}
  }));
  return runtime.jsx("box", {
  flexDirection: "column", gap: 1, paddingLeft: 1, paddingRight: 1, paddingBottom: 1, flexGrow: 1, focusable: true, onKeyDown: controller.handleKey,
  children: () => {
    const result = controller.snapshot();
    const workspaces = controller.workspaces();
    const selected = controller.selectedWorkspace();
    const stage = controller.selectedStage();
    const data = result?.data;
    const status = result?.stale ? `STALE · ${result.error?.code || "STORAGE_ERROR"}` : result?.ok === false ? `ERROR · ${result.error?.code || "STORAGE_ERROR"}` : "LIVE";
    const muted = theme?.current?.textMuted;
    const selectedWorkspaceIndex = selected ? workspaces.indexOf(selected) : -1;
    const selectedStageIndex = stage && selected ? (selected.stages || []).indexOf(stage) : -1;
    const workspaceItems = workspaces.map((workspace, index) => runtime.jsx("box", {
      id: `workspace-${workspace.id}`, flexDirection: "row", gap: 1, children: [
        line(runtime, index === selectedWorkspaceIndex ? ">" : " ", { flexShrink: 0, marginRight: 1, fg: index === selectedWorkspaceIndex ? theme?.current?.text : muted }),
        line(runtime, `${workspace.id}  ${workspace.title}`, { flexGrow: 1, flexShrink: 1, wrapMode: "word", fg: workspace.id === data?.currentWorkspace ? theme?.current?.warning : theme?.current?.text }),
        line(runtime, workspace.status, { flexShrink: 0, fg: muted }),
      ],
    }));
    const stageItems = selected ? (selected.stages || []).map((item, index) => runtime.jsx("box", {
      id: `stage-${item.id}`, flexDirection: "row", children: [
        line(runtime, index === selectedStageIndex ? ">" : " ", { flexShrink: 0, marginRight: 1, fg: index === selectedStageIndex ? theme?.current?.text : muted }),
        line(runtime, `${marker(item.status)} ${item.id}. ${item.title}${item.current ? " · current" : ""}`, { flexGrow: 1, flexShrink: 1, wrapMode: "word", fg: item.current ? theme?.current?.warning : theme?.current?.text }),
      ],
    })) : [];
    const children = [runtime.jsx("box", {
      flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2,
      children: [
        line(runtime, runtime.jsx("b", { children: "Work Context" }), { fg: theme?.current?.text }),
        line(runtime, "esc", { fg: muted }),
      ],
    }), runtime.jsx("box", {
      flexDirection: "column", gap: 0, paddingLeft: 2, paddingRight: 2,
      children: [
        line(runtime, `Filter  ${controller.query() || "type to filter"}`, { fg: controller.query() ? theme?.current?.text : muted }),
        line(runtime, `Status  ${status}`, { fg: result?.stale || result?.ok === false ? theme?.current?.warning : muted }),
      ],
    })];
    if (result?.ok === false && !data) children.push(runtime.jsx("box", { paddingLeft: 2, children: line(runtime, result.error?.message || "Cannot read work-context storage", { fg: theme?.current?.error }) }));
    if (!workspaces.length) children.push(line(runtime, controller.query() ? "No matching workspaces or stages." : "No workspaces found.", { paddingLeft: 2, fg: muted }));
    else children.push(runtime.jsx("box", {
      flexDirection: "row", gap: 2, flexGrow: 1, paddingLeft: 2, paddingRight: 2,
      children: [
        runtime.jsx("box", { flexDirection: "column", width: "40%", flexShrink: 0, children: [
          line(runtime, "Workspaces", { fg: muted }),
          runtime.jsx("scrollbox", { ref: (node) => { workspaceScroll = node; }, maxHeight: maxListHeight, scrollY: true, verticalScrollbarOptions: { visible: false }, children: workspaceItems }),
        ] }),
        runtime.jsx("box", { flexDirection: "column", flexGrow: 1, flexShrink: 1, children: [
          line(runtime, selected ? `Stages  ${selected.title}` : "Stages", { wrapMode: "word", fg: muted }),
          runtime.jsx("scrollbox", { ref: (node) => { stageScroll = node; }, maxHeight: maxListHeight, scrollY: true, verticalScrollbarOptions: { visible: false }, children: stageItems }),
          ...(controller.details() && stage ? [
            line(runtime, "Details", { marginTop: 1, fg: muted }),
            line(runtime, stage.description || "No description.", { wrapMode: "word", fg: theme?.current?.text }),
            line(runtime, `Sessions  ${(selected.sessions || []).length}`, { fg: muted }),
            ...(selected.sessions || []).map((session) => line(runtime, `${session.state || "unknown"}  ${session.session_id || "unknown"}  stage ${session.stage || "-"}`, { wrapMode: "word", fg: muted })),
          ] : []),
        ] }),
      ],
    }));
    const prepared = controller.preparedCommand();
    if (prepared) children.push(runtime.jsx("box", { paddingLeft: 2, paddingRight: 2, children: line(runtime, prepared.command
      ? `Prepared (not submitted): ${prepared.command}${prepared.error ? ` · ${prepared.error.message || prepared.error.code}` : ""}`
      : `Command unavailable: ${prepared.error?.message || prepared.error?.code || "INVALID_ARGUMENT"}`, { fg: prepared.error ? theme?.current?.warning : theme?.current?.text }) }));
    children.push(runtime.jsx("box", { paddingLeft: 2, paddingRight: 2, children: line(runtime, "↑↓ workspace · ←→ stage · d/Enter details · l list · r resume · h handoff · f finish", { fg: muted }) }));
    return children;
  },
  });
};

export const buildWorkContextActionCommand = (action, { workspace, stage, value, prompt } = {}) => {
  if (action === "help" || action === "list") return { ok: true, command: `/wc ${action}` };
  if (action === "create") return value?.trim()
    ? { ok: true, command: `/wc create ${quoteWorkContextArgument(value.trim())}` }
    : { ok: false, error: { code: "INVALID_ARGUMENT", message: "Title is required" } };
  if (action === "session.rename") return value?.trim()
    ? { ok: true, command: `/wc session rename ${quoteWorkContextArgument(value.trim())}` }
    : { ok: false, error: { code: "INVALID_ARGUMENT", message: "Summary is required" } };
  const normalizedWorkspace = normalizedId(normalizeWorkspaceId, workspace);
  if (!normalizedWorkspace) return { ok: false, error: { code: "INVALID_ARGUMENT", message: "Invalid workspace ID" } };
  if (action === "workspace.list") return { ok: true, command: `/wc workspace list ${normalizedWorkspace}` };
  if (action === "workspace.finish") return { ok: true, command: `/wc workspace finish ${normalizedWorkspace}` };
  if (action === "workspace.rename") return value?.trim()
    ? { ok: true, command: `/wc workspace rename ${normalizedWorkspace} ${quoteWorkContextArgument(value.trim())}` }
    : { ok: false, error: { code: "INVALID_ARGUMENT", message: "Title is required" } };
  if (action === "stage.add") {
    if (!value?.trim()) return { ok: false, error: { code: "INVALID_ARGUMENT", message: "Title is required" } };
    return { ok: true, command: `/wc stage add ${normalizedWorkspace} ${quoteWorkContextArgument(value.trim())}${prompt?.trim() ? ` ${quoteWorkContextArgument(prompt.trim())}` : ""}` };
  }
  const normalizedStage = normalizedId(normalizeStageId, stage);
  if (!normalizedStage) return { ok: false, error: { code: "INVALID_ARGUMENT", message: "Invalid stage ID" } };
  const commandName = action.replace(".", " ");
  if (["resume", "stage.archive", "stage.handoff", "stage.abandon", "stage.finish"].includes(action)) return { ok: true, command: `/wc ${commandName} ${normalizedWorkspace} ${normalizedStage}` };
  const inputCommands = { "stage.rename": "title", "stage.update": "description", "stage.update-prompt": "prompt", "stage.update-result": "result" };
  if (Object.hasOwn(inputCommands, action)) return value?.trim()
    ? { ok: true, command: `/wc ${commandName} ${normalizedWorkspace} ${normalizedStage} ${quoteWorkContextArgument(value.trim())}` }
    : { ok: false, error: { code: "INVALID_ARGUMENT", message: `${inputCommands[action][0].toUpperCase()}${inputCommands[action].slice(1)} is required` } };
  return { ok: false, error: { code: "INVALID_ARGUMENT", message: "Unsupported work-context action" } };
};

export const createWorkContextActionFlow = (api, { projectRoot, sessionId, read = readWorkContextSnapshot, openStage = openStageSwitcher } = {}) => {
  const stack = api?.ui?.dialog;
  const toast = (message, variant = "warning") => api?.ui?.toast?.({ message, variant });
  const showSelect = (title, options, onSelect, props = {}) => stack.replace(() => api.ui.DialogSelect({ title, placeholder: "Search", options, onSelect, ...props }));
  const showPrompt = (title, placeholder, onConfirm) => stack.replace(() => api.ui.DialogPrompt({ title, placeholder, onConfirm }));
  const insert = async (prepared) => {
    if (!prepared.ok) { toast(prepared.error.message); return; }
    stack.clear();
    const inserted = await appendPromptCommand(api, prepared.command);
    toast(inserted.ok ? "Command added to prompt" : inserted.error?.message || "Prompt insertion failed", inserted.ok ? "success" : "error");
  };
  const requireValue = (title, placeholder, action, context = {}) => showPrompt(title, placeholder, (value) => {
    const prepared = buildWorkContextActionCommand(action, { ...context, value });
    if (!prepared.ok) { toast(prepared.error.message); requireValue(title, placeholder, action, context); return; }
    void insert(prepared);
  });
  const addStage = (workspace) => showPrompt("Add stage", "Stage title", (title) => {
    if (!title?.trim()) { toast("Title is required"); addStage(workspace); return; }
    showPrompt("Add stage prompt", "Optional detailed prompt", (prompt) => void insert(buildWorkContextActionCommand("stage.add", { workspace, value: title, prompt })));
  });
  const runStageAction = (action, workspace, stage) => {
    const context = { workspace, stage };
    if (action === "stage.rename") requireValue("Rename stage", "New title", action, context);
    else if (action === "stage.update") requireValue("Update stage description", "Description", action, context);
    else if (action === "stage.update-prompt") requireValue("Update stage prompt", "Detailed prompt", action, context);
    else if (action === "stage.update-result") requireValue("Update stage result", "Completion result", action, context);
    else void insert(buildWorkContextActionCommand(action, context));
  };
  const selectStage = (action, workspace, stages) => showSelect("Select stage", stages.map((stage) => ({
    title: `${marker(stage.status)} ${stage.id}. ${stage.title}`,
    description: stage.description || stage.status,
    value: stage,
  })), (option) => runStageAction(action, workspace, option.value.id));
  const loadWorkspaces = async () => {
    let result;
    try { result = await read({ projectRoot, sessionId }); }
    catch (error) { toast(error.message || "Cannot read work-context storage", "error"); return null; }
    if (!result?.ok) { toast(result?.error?.message || "Cannot read work-context storage", "error"); return null; }
    const workspaces = result.data?.workspaces || [];
    if (!workspaces.length) { toast("No workspaces found"); return null; }
    return { workspaces, currentWorkspace: result.data?.currentWorkspace };
  };
  const selectWorkspace = async (action) => {
    const loaded = await loadWorkspaces();
    if (!loaded) return;
    const { workspaces } = loaded;
    showSelect("Select workspace", workspaces.map((workspace) => ({
      title: `${workspace.id}  ${workspace.title}`,
      description: workspace.status,
      value: workspace,
    })), (option) => {
      const workspace = option.value;
      if (action === "workspace.list" || action === "workspace.finish") void insert(buildWorkContextActionCommand(action, { workspace: workspace.id }));
      else if (action === "workspace.rename") requireValue("Rename workspace", "New title", action, { workspace: workspace.id });
      else if (action === "stage.add") addStage(workspace.id);
      else if (!workspace.stages?.length) toast("No stages found");
      else selectStage(action, workspace.id, workspace.stages);
    });
  };
  const progress = (workspace) => {
    const counts = (workspace.stages || []).reduce((all, stage) => ({ ...all, [stage.status]: (all[stage.status] || 0) + 1 }), {});
    return [["completed", "✓"], ["in_progress", "•"], ["planned", "□"], ["cancelled", "!"]]
      .flatMap(([status, symbol]) => counts[status] ? [`${symbol}${counts[status]}`] : [])
      .join(" ") || "No stages";
  };
  const showWorkspaceActions = (workspace) => showSelect(`${workspace.id}  ${workspace.title}`, [
    { title: "Back to workspaces", value: "back", category: "Navigation" },
    ...WORK_CONTEXT_ACTIONS.filter((action) => ["workspace.list", "stage.add", "workspace.rename", "workspace.finish"].includes(action.value)),
  ], (option) => {
    if (option.value === "back") { void browseWorkspaces(); return; }
    if (option.value === "workspace.list" || option.value === "workspace.finish") void insert(buildWorkContextActionCommand(option.value, { workspace: workspace.id }));
    else if (option.value === "workspace.rename") requireValue("Rename workspace", "New title", option.value, { workspace: workspace.id });
    else if (option.value === "stage.add") addStage(workspace.id);
  });
  const showStageActions = (workspace, stage, { backTitle = "Back to workspaces", onBack = () => void browseWorkspaces() } = {}) => showSelect(`${workspace.id}/${stage.id}  ${stage.title}`, [
    { title: backTitle, value: "back", category: "Navigation" },
    ...WORK_CONTEXT_ACTIONS.filter((action) => ["resume", "stage.rename", "stage.update", "stage.update-prompt", "stage.update-result", "stage.archive", "stage.handoff", "stage.abandon", "stage.finish"].includes(action.value)),
  ], (option) => {
    if (option.value === "back") { onBack(); return; }
    runStageAction(option.value, workspace.id, stage.id);
  });
  const browseWorkspaces = async () => {
    const loaded = await loadWorkspaces();
    if (!loaded) return;
    const rank = { in_progress: 0, planned: 1, completed: 2, cancelled: 3 };
    const workspaces = [...loaded.workspaces].sort((left, right) => {
      if (left.id === loaded.currentWorkspace) return -1;
      if (right.id === loaded.currentWorkspace) return 1;
      return (rank[left.status] ?? 9) - (rank[right.status] ?? 9) || left.id.localeCompare(right.id);
    });
    const options = workspaces.flatMap((workspace) => {
      const category = `${workspace.id} · ${workspace.title} · ${workspace.status}`;
      return [
        { title: "Overview", description: workspace.status, footer: progress(workspace), category, value: { type: "workspace", workspace } },
        ...(workspace.stages || []).map((stage) => ({
          title: `${marker(stage.status)} ${stage.id}. ${stage.title}${stage.current ? " · current" : ""}`,
          description: stage.description || stage.status,
          category,
          value: { type: "stage", workspace, stage },
        })),
      ];
    });
    showSelect("Workspaces", options, (option) => {
      if (option.value.type === "workspace") showWorkspaceActions(option.value.workspace);
      else showStageActions(option.value.workspace, option.value.stage);
    });
  };
  const browseStages = async () => {
    const loaded = await loadWorkspaces();
    if (!loaded) return;
    const rank = { in_progress: 0, planned: 1, completed: 2, cancelled: 3 };
    const entries = loaded.workspaces.flatMap((workspace) => (workspace.stages || []).map((stage) => ({ workspace, stage })));
    if (!entries.length) { toast("No stages found"); return; }
    entries.sort((left, right) => {
      if (left.stage.current) return -1;
      if (right.stage.current) return 1;
      return (rank[left.stage.status] ?? 9) - (rank[right.stage.status] ?? 9)
        || left.workspace.id.localeCompare(right.workspace.id)
        || Number(left.stage.id) - Number(right.stage.id);
    });
    const labels = { in_progress: "In progress", planned: "Planned", completed: "Completed", cancelled: "Cancelled" };
    showSelect("Stages", entries.map(({ workspace, stage }) => ({
      title: `${marker(stage.status)} ${workspace.id}/${stage.id}  ${stage.title} · ${workspace.title}`,
      description: stage.description || stage.status,
      category: stage.current ? "Current" : labels[stage.status] || stage.status,
      value: { workspace, stage },
    })), (option) => showStageActions(option.value.workspace, option.value.stage, { backTitle: "Back to stages", onBack: () => void browseStages() }));
  };
  const sessionOrdinal = (session) => String(session.ordinal).includes("/")
    ? String(session.ordinal)
    : `${session.stage}/${String(session.ordinal).padStart(2, "0")}`;
  const showSessionDetails = (workspace, session) => {
    const stage = (workspace.stages || []).find((item) => item.id === session.stage);
    const options = [
      { title: "Back to sessions", value: "back", category: "Navigation" },
      ...(stage ? [{ title: "Open stage actions", value: "stage", category: "Navigation" }] : []),
      { title: `Workspace  ${workspace.id}  ${workspace.title}`, value: "workspace", category: "Details", disabled: true },
      { title: `Stage  ${session.stage}${stage ? `  ${stage.title}` : ""}`, value: "stage-detail", category: "Details", disabled: true },
      { title: `State  ${session.state || "unknown"}`, value: "state", category: "Details", disabled: true },
      { title: `Summary  ${session.summary || "No summary"}`, value: "summary", category: "Details", disabled: true },
      { title: `Session  ${session.session_id}`, value: "session", category: "Details", disabled: true },
      ...(session.opencode_session_id ? [{ title: `OpenCode  ${session.opencode_session_id}`, value: "opencode", category: "Details", disabled: true }] : []),
      ...(session.branch ? [{ title: `Branch  ${session.branch}`, value: "branch", category: "Details", disabled: true }] : []),
      ...(session.updated_at ? [{ title: `Updated  ${session.updated_at}`, value: "updated", category: "Details", disabled: true }] : []),
    ];
    showSelect(`${workspace.id} ${sessionOrdinal(session)}`, options, (option) => {
      if (option.value === "back") { void browseSessions(); return; }
      if (option.value === "stage" && stage) showStageActions(workspace, stage, { backTitle: "Back to session", onBack: () => showSessionDetails(workspace, session) });
    });
  };
  const browseSessions = async () => {
    const loaded = await loadWorkspaces();
    if (!loaded) return;
    const rank = { active: 0, handed_off: 1, abandoned: 2, closed: 3 };
    const entries = loaded.workspaces.flatMap((workspace) => (workspace.sessions || []).map((session) => ({ workspace, session })));
    if (!entries.length) { toast("No sessions found"); return; }
    entries.sort((left, right) => {
      const leftCurrent = left.session.opencode_session_id === sessionId || left.session.session_id === sessionId;
      const rightCurrent = right.session.opencode_session_id === sessionId || right.session.session_id === sessionId;
      if (leftCurrent) return -1;
      if (rightCurrent) return 1;
      return (rank[left.session.state] ?? 9) - (rank[right.session.state] ?? 9)
        || String(right.session.updated_at || "").localeCompare(String(left.session.updated_at || ""));
    });
    const labels = { active: "Active", handed_off: "Handed off", abandoned: "Abandoned", closed: "Closed" };
    showSelect("Sessions", entries.map(({ workspace, session }) => {
      const current = session.opencode_session_id === sessionId || session.session_id === sessionId;
      return {
        title: `${workspace.id} ${sessionOrdinal(session)}  ${session.summary || "Work session"} · ${workspace.title}`,
        description: `${session.state || "unknown"} · ${session.session_id}`,
        footer: session.updated_at || session.started_at,
        category: current ? "Current" : labels[session.state] || session.state || "Unknown",
        value: { workspace, session },
      };
    }), (option) => showSessionDetails(option.value.workspace, option.value.session));
  };
  const selectAction = (action) => {
    if (action === "help") void insert(buildWorkContextActionCommand(action));
    else if (action === "switch.stage") openStage(api);
    else if (action === "switch.workspace") openWorkspaceSwitcher(api);
    else if (action === "switch.session") openSessionSwitcher(api);
    else if (action === "list") void browseWorkspaces();
    else if (action === "browse.stages") void browseStages();
    else if (action === "browse.sessions") void browseSessions();
    else if (action === "create") requireValue("Create workspace", "Workspace title", action);
    else if (action === "session.rename") requireValue("Rename work session", "Session summary", action);
    else void selectWorkspace(action);
  };
  const open = () => {
    stack.setSize?.("medium");
    showSelect("Work Context", WORK_CONTEXT_ACTIONS, (option) => selectAction(option.value));
  };
  return { open, selectAction };
};

export const openWorkContextActionDialog = (api, runtime = {}, options = {}) => {
  if (typeof api?.ui?.DialogSelect !== "function" || typeof api?.ui?.DialogPrompt !== "function" || typeof api?.ui?.dialog?.replace !== "function") return openCompatibilityDialog(api, runtime, options);
  const flow = createWorkContextActionFlow(api, {
    projectRoot: options.projectRoot || api.state?.path?.worktree,
    sessionId: api.route?.current?.params?.sessionID || api.route?.current?.params?.sessionId,
    read: options.read || readWorkContextSnapshot,
  });
  flow.open();
  return true;
};

export const openCompatibilityDialog = (api, runtime = {}, options = {}) => {
  const stack = api?.ui?.dialog;
  if (!stack || typeof runtime.jsx !== "function" || typeof stack.replace !== "function") return false;
  const projectRoot = options.projectRoot || api.state?.path?.worktree;
  const sessionId = api.route?.current?.params?.sessionID || api.route?.current?.params?.sessionId;
  let watcher;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    controller.dispose();
    watcher?.close();
    closeDialog(api);
  };
  const controller = createWorkContextModalController({ projectRoot, sessionId, read: options.read || readWorkContextSnapshot, createSignal: runtime.createSignal, onClose: close, onCommand: (command) => insertPromptCommand(api, command) });
  try { watcher = projectRoot && fs.watch(path.join(projectRoot, ".work-context"), { recursive: true }, () => controller.scheduleRefresh?.()); } catch {}
  const maxListHeight = Math.max(8, Math.floor((api.renderer?.height || 60) / 2) - 6);
  const render = () => renderWorkContextModal(controller, api.theme, runtime, { maxListHeight });
  stack.replace(render, close);
  return true;
};

export const registerWorkContextModal = (api, runtime = {}) => {
  if (typeof api?.keymap?.registerLayer !== "function") return { supported: false, dispose: () => {} };
  const command = { name: COMMAND_NAME, title: "Open Work Context", desc: "Open work-context navigation and actions", category: "Work Context", namespace: "palette", run: () => openWorkContextActionDialog(api, runtime) };
  const stageCommand = { name: "work_context.stage", title: "Switch Work Context Stage", desc: "Open a stage session in the current workspace", category: "Work Context", namespace: "palette", run: () => openStageSwitcher(api) };
  const workspaceCommand = { name: "work_context.workspace", title: "Switch Work Context Workspace", desc: "Open a workspace session", category: "Work Context", namespace: "palette", run: () => openWorkspaceSwitcher(api) };
  const sessionCommand = { name: "work_context.session", title: "Switch Work Context Session", desc: "Open an active or historical work session", category: "Work Context", namespace: "palette", run: () => openSessionSwitcher(api) };
  const actions = { name: ACTIONS_COMMAND_NAME, title: "Open Work Context Actions", desc: "Prepare a work-context command", category: "Work Context", namespace: "palette", run: () => openWorkContextActionDialog(api, runtime) };
  const registration = api.keymap.registerLayer({
    commands: [command, stageCommand, workspaceCommand, sessionCommand, actions],
    bindings: [
      { key: SHORTCUT, cmd: COMMAND_NAME, desc: command.title },
      { key: STAGE_SHORTCUT, cmd: stageCommand.name, desc: stageCommand.title },
      { key: WORKSPACE_SHORTCUT, cmd: workspaceCommand.name, desc: workspaceCommand.title },
      { key: SESSION_SHORTCUT, cmd: sessionCommand.name, desc: sessionCommand.title },
    ],
  });
  return { supported: true, dispose: () => disposeRegistration(registration) };
};

export const tui = async (api, options = {}) => {
  activeTuiInstances.get(api)?.();
  const registration = registerWorkContextModal(api, options.runtime || options);
  if (!registration.supported) return;
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    registration.dispose();
  };
  activeTuiInstances.set(api, cleanup);
  api.lifecycle?.onDispose?.(cleanup);
  return cleanup;
};

export default { id: "work-context-modal", tui };
