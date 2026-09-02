#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";

const cyrillic = /[\u0400-\u04ff]/u;
const excludedPrefixes = [".work-context/local/"];
const result = spawnSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
);

if (result.error || result.status !== 0) {
  const reason = result.error?.message || result.stderr.trim() || `exit status ${result.status}`;
  console.error(`Language check failed to list repository files: ${reason}`);
  process.exit(1);
}

const violations = [];
const files = result.stdout.split("\0").filter(Boolean);

for (const file of files) {
  if (excludedPrefixes.some((prefix) => file.startsWith(prefix))) continue;
  if (cyrillic.test(file)) {
    violations.push(`${file}: filename contains Cyrillic text`);
    continue;
  }

  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    console.error(`Language check failed to inspect ${file}: ${error.message}`);
    process.exit(1);
  }
  if (!stat.isFile()) continue;

  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;

  content.toString("utf8").split(/\r?\n/u).forEach((line, index) => {
    if (cyrillic.test(line)) violations.push(`${file}:${index + 1}: ${line.trim()}`);
  });
}

if (violations.length) {
  console.error("Cyrillic text found in repository files:\n");
  for (const violation of violations) console.error(violation);
  process.exit(1);
}

console.log(`Language check passed (${files.length} repository files inspected).`);
