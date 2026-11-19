import { createHash } from "node:crypto";

export const WORK_CONTEXT_PROTOCOL = Object.freeze({
  schema: 1,
  major: 1,
  minor: 0,
});

export const WORK_CONTEXT_PROTOCOL_DESCRIPTOR = Object.freeze({
  schema: WORK_CONTEXT_PROTOCOL.schema,
  name: "opencode-work-context/wc",
  protocol: Object.freeze({
    major: WORK_CONTEXT_PROTOCOL.major,
    minor: WORK_CONTEXT_PROTOCOL.minor,
  }),
  operations: Object.freeze(["delivery.doctor"]),
});

export const WORK_CONTEXT_PROTOCOL_DESCRIPTOR_BYTES = JSON.stringify(WORK_CONTEXT_PROTOCOL_DESCRIPTOR);
export const WORK_CONTEXT_PROTOCOL_DESCRIPTOR_HASH = createHash("sha256")
  .update(WORK_CONTEXT_PROTOCOL_DESCRIPTOR_BYTES)
  .digest("hex");

export const WORK_CONTEXT_PROTOCOL_MARKER = `<!-- opencode-work-context-protocol: ${JSON.stringify({
  schema: WORK_CONTEXT_PROTOCOL.schema,
  major: WORK_CONTEXT_PROTOCOL.major,
  minor: WORK_CONTEXT_PROTOCOL.minor,
  descriptor_hash: `sha256:${WORK_CONTEXT_PROTOCOL_DESCRIPTOR_HASH}`,
})} -->`;

export function parseWorkContextProtocolMarker(content) {
  if (typeof content !== "string") return null;
  const matches = [...content.matchAll(/<!-- opencode-work-context-protocol: (\{[^\r\n]*\}) -->/g)];
  if (matches.length !== 1) return null;
  try {
    const marker = JSON.parse(matches[0][1]);
    if (!marker || typeof marker !== "object" || Array.isArray(marker)
      || !Number.isInteger(marker.schema) || marker.schema < 1
      || !Number.isInteger(marker.major) || marker.major < 0
      || !Number.isInteger(marker.minor) || marker.minor < 0
      || typeof marker.descriptor_hash !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(marker.descriptor_hash)) return null;
    return marker;
  } catch {
    return null;
  }
}
