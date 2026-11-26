// Loads the DDICBot env keys from ~/.hermes/.env when they are not already
// present in the process environment. Returns a record of only the values
// actually resolved — secrets are never printed.
//
// Used by db/migrate.ts and the scripts/* tooling. (The Next.js runtime uses
// plain process.env via lib/env.ts instead of this helper.)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WANTED = [
  "NEON_DATABASE_URL",
  "DDICBOT_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "VERCEL_ACCESS_TOKEN",
  "DEEPSEEK_API_KEY",
];

export function loadHermesEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of WANTED) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  try {
    const file = join(homedir(), ".hermes", ".env");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && WANTED.includes(m[1]) && !out[m[1]]) {
        out[m[1]] = m[2].replace(/^"|"$/g, "");
      }
    }
  } catch {
    // no ~/.hermes/.env — rely on process env only
  }
  return out;
}
