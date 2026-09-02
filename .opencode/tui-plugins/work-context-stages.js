// Keep package logic and reactive nodes in the OpenCode-owned runtime graph.
// Use the same Solid entrypoint as OpenCode's Bun TUI runtime. Importing the
// dist subpath creates a separate reactive module graph and signals do not
// invalidate host-rendered slot content.
import { createSignal } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";
import plugin from "../../plugin/tui.js";

export default {
  ...plugin,
  async tui(api, options) {
    return plugin.tui(api, {
      ...options,
      runtime: { createSignal, jsx },
    });
  },
};
