import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkContext } from "../../src/index.js";

export function createFixture() {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "work-context-integration-"));
  const context = WorkContext.open(root, { actor: "integration-test" });
  return {
    root,
    context,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function createSessionHost(root, sessionId) {
  let title = "";
  const updates = [];
  const client = {
    session: {
      get: async () => ({ data: { id: sessionId, title } }),
      update: async ({ body }) => { title = body.title; updates.push(body.title); },
    },
  };
  return {
    client,
    directory: root,
    worktree: root,
    get title() { return title; },
    updates,
  };
}
