import stages from "./stages-tui.js";
import modal from "./work-context-modal.js";

// Keep the sidebar and modal adapters composed under one optional TUI entry.
// The server plugin remains a separate runtime contract.
export const tui = async (api, options = {}) => {
  await stages.tui(api, options);
  await modal.tui(api, options);
};

// Preserve the original package entrypoint identity so nested OpenCode configs
// deduplicate older stages-only loaders before either can register a second slot.
export default { id: stages.id, tui };
