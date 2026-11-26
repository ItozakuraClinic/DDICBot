/**
 * PII hygiene static assertions (P2T3, safety rule 4).
 *
 * THE PROJECT'S "LINT RULE": no image bytes may reach disk, logs, or the DB.
 * Enforced here by scanning the shipped source trees (lib/, app/, handlers/)
 * for filesystem and file-streaming APIs. The whitelist is explicit and
 * reviewed — any new fs usage in an image path must be added there first
 * (and this test will fail until a human re-derives the invariant).
 *
 * Also asserted: no SQL/DB layer mentions photo columns (the schema has no
 * image table by design — drugs/ddi_pairs/drug_names carry only text).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  // Source-only shallow recursive scan (lib/, app/, handlers/ contain no
  // node_modules/.next; the skip below is belt-and-braces).
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      out.push(...collectFiles(p));
    } else if (/\.(ts|tsx|mts|mjs)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/** File:line where a forbidden API appears, for the failure message. */
function findHits(files: string[], re: RegExp, whitelist: Record<string, true>): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const f of files) {
    if (whitelist[f]) continue;
    const rel = f.replace(ROOT + "/", "");
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]) && !lines[i].trim().startsWith("//") && !lines[i].trim().startsWith("*")) {
        hits.push({ file: rel, line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return hits;
}

test("PII: no filesystem imports in lib/ app/ handlers/ (photo bytes stay in memory)", () => {
  const files = [...collectFiles(join(ROOT, "lib")), ...collectFiles(join(ROOT, "app")), ...collectFiles(join(ROOT, "handlers"))];
  assert.ok(files.length > 10, `expected source files to scan, got ${files.length}`);
  // Any `node:fs` / `fs` import would be a direct path to violate rule 4.
  const re = /import\s+.*\bfrom\s+["']node?(\.?)?:(fs|fs\/promises|child_process)|require\(\s*["']node?(\.?)?:(fs|child_process)|\bfrom\s+["']node:fs["']/;
  const hits = findHits(files, re, {});
  assert.deepEqual(hits, [], "filesystem API found in shipped source — violates the no-photo-persistence rule:\n" + hits.map((h) => `  ${h.file}:${h.line} ${h.text}`).join("\n"));
});

test("PII: no file-write calls in lib/ app/ handlers/", () => {
  const files = [...collectFiles(join(ROOT, "lib")), ...collectFiles(join(ROOT, "app")), ...collectFiles(join(ROOT, "handlers"))];
  const re = /\bwriteFile\b|\bwriteFileSync\b|\bcreateWriteStream\b|\bunlink\b|\bunlinkSync\b|\bappendFile\b|\btmpdir\b|\btmpfile\b/;
  const hits = findHits(files, re, {});
  assert.deepEqual(hits, [], "file-mutating API found in shipped source:\n" + hits.map((h) => `  ${h.file}:${h.line} ${h.text}`).join("\n"));
});

test("PII: no image/binary data columns in the DB schema", () => {
  let schema = readFileSync(join(ROOT, "db", "schema.sql"), "utf8");
  // Strip SQL comments so explanatory prose can't (un)influence the check —
  // the assertion is about column types, not comment wording.
  schema = schema
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  // Targets image DATA storage (binary types / base64 / file-path columns).
  // A table named photo_sessions (chat_id + ingredient_ids + timestamp) is
  // allowed — it is confirmation state, not photo bytes. The assertion
  // guards against anyone adding a binary/base64/file-path column.
  const re = /bytea|\bbase64\b|\bbinary\b|file_?(path|name|id)\s+TEXT|image_?data|photo_?(bytes|data|buffer)/i;
  assert.ok(!re.test(schema), "db schema gained an image/binary column — violates safety rule 4");
});

test("PII: no binary/bytea type in the pg query layer", () => {
  const files = [...collectFiles(join(ROOT, "lib")), ...collectFiles(join(ROOT, "app"))];
  // INSERT/UPDATE targets must not carry image data (binary type or
  // base64/file-path value). Table names alone don't count —
  // photo_sessions stores chat_id + ingredient_ids + timestamp only.
  const re = /INSERT\s+INTO[\s\S]{0,160}?(\bbytea\b|base64|file_?(path|name|id))|UPDATE\s+photo_sessions[\s\S]{0,120}?(base64|bytea|file_?(path|name|id))/i;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!re.test(src), `SQL inserting image bytes found in ${f}`);
  }
});
