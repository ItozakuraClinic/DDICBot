/**
 * DDICBot P3 final-QA local production verification (scripts/qa-matrix.ts).
 *
 * What this script proves on the REAL local prod stack:
 *  1. `npm run build` (next build) is green and `next start` serves the
 *     built app on a free local port.
 *  2. The /api/tg-webhook route is live end-to-end: secret-token auth
 *     (405 without / with a wrong token), GET health probe (200), and
 *     every crafted Telegram update POST returns HTTP 200 through the
 *     production route (auth → JSON → handleUpdate).
 *  3. /lang switching through the HTTP route is DB-persisted: after each
 *     `POST /lang <x>` the chat_langs row for the QA chat id is read back
 *     from Neon and must equal <x> (readable DB ground truth — this is
 *     what machine-proves the handler ran through the real route).
 *  4. Reply TEXT is asserted in-process via the scripts/simulate-check.ts
 *     pattern: the same crafted updates are driven through the same
 *     grammY Bot instance type with ONLY the outbound Bot API
 *     (Api.prototype.sendMessage) stubbed to capture reply text, while
 *     parsing, name resolution, DDI SQL and rendering run for real
 *     against the live Neon branch. (An HTTP-POSTed reply cannot be read
 *     back over the webhook — Telegram webhooks return only {ok:true};
 *     see the design notes in scripts/simulate-check.ts.)
 *
 * Per-response assertions (every /check reply, in each of zh/en/ja):
 *  - correct severity badge (zh/en: P2 bilingual form; ja: 重大/中度/軽微/未分類)
 *  - mechanism line shape per language (see lib/render.ts doc):
 *      zh: 机制: <zh> | 机制说明（英文）: <en> | 来源未提供机制说明
 *      en: Mechanism: <en> | No mechanism text on record…
 *      ja: 仕組み: <ja> | Mechanism: <en> | No mechanism text on record…
 *  - not-found responses: the EXACT pinned line for the language
 *      zh: 数据库未收录该组合，不代表无相互作用。
 *      en: This combination is not in our database
 *      ja: この組み合わせはデータベースに収録されていません
 *    plus the other two pinned lines still present (never-drop rule).
 *  - both mandatory lines (EMERGENCY_LINE, DISCLAIMER_LINE) present.
 *  - nowhere in the reply text: "no interaction" / "safe" / "no problem".
 *
 * The pair matrix is docs/final-qa-pairs.json (severities verified against
 * the live ddi_pairs at authoring time; the script re-verifies them against
 * Neon at startup and fails loudly on drift).
 *
 * Usage: npx tsx scripts/qa-matrix.ts
 * Writes: docs/qa-matrix-log.md, docs/e2e/qa-matrix-summary.json
 * Exits:  0 all pass, 1 any failure. No secrets are printed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadHermesEnv } from "./_load-env.ts";
import { readFileSync } from "node:fs";

const root = fileURLToPath(new URL("..", import.meta.url));

// ── env (repo .env > ~/.hermes/.env; process env wins) ────────────────────
function parseDotEnv(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch { /* missing file */ }
  return out;
}
const repoEnv = parseDotEnv(join(root, ".env"));
const hermes = loadHermesEnv();
const NEON = process.env.NEON_DATABASE_URL || repoEnv.NEON_DATABASE_URL || hermes.NEON_DATABASE_URL || "";
if (!NEON) {
  console.error("NEON_DATABASE_URL not resolved — refusing to run.");
  process.exit(2);
}
// lib/db.ts getPool (used by the reply lane's live resolution/DDI) reads
// process.env — the repo .env is not loaded by the Next runtime either.
process.env.NEON_DATABASE_URL = NEON;

// Local-only webhook secret: generated per run (never a real/known secret).
const LOCAL_SECRET = randomBytes(24).toString("hex");

// ── pair matrix ───────────────────────────────────────────────────────────
interface FoundPair {
  pair: [string, string];
  expected: "Major" | "Moderate" | "Minor" | "Unknown";
  ids: [string, string];
  mechanismEn: boolean;
  mechanismZh: boolean;
  mechanismJa: boolean;
}
interface NotFoundPair { pair: [string, string]; expected: "notfound"; ids: [string, string] }
const matrix = JSON.parse(readFileSync(join(root, "docs", "final-qa-pairs.json"), "utf8")) as {
  found: FoundPair[];
  notfound: NotFoundPair[];
};

// ── result bookkeeping ────────────────────────────────────────────────────
interface CaseResult {
  lane: "http" | "reply" | "gate";
  name: string;
  pass: boolean;
  detail: string;
}
const results: CaseResult[] = [];
const logLines: string[] = [];
function say(s: string): void {
  console.log(s);
  logLines.push(s);
}
function record(lane: CaseResult["lane"], name: string, pass: boolean, detail = ""): void {
  results.push({ lane, name, pass, detail });
  say(`  ${pass ? "PASS" : "FAIL"} [${lane}] ${name}${pass ? "" : " — " + detail}`);
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => res(p));
    });
    srv.on("error", rej);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── HTTP lane: build + start + crafted-update POSTs ───────────────────────
async function httpLane(port: number): Promise<number> {
  const base = `http://127.0.0.1:${port}/api/tg-webhook`;
  let updateId = 500_000;
  const QA_CHAT = 780_555_001; // reserved QA chat id (cleaned up afterwards)
  let failures = 0;

  const postUpdate = async (text: string) => {
    const msg: Record<string, unknown> = {
      message_id: updateId,
      from: { id: QA_CHAT, is_bot: false, first_name: "QA", username: "qa_matrix" },
      chat: { id: QA_CHAT, type: "private", first_name: "QA" },
      date: Math.floor(Date.now() / 1000),
      text,
    };
    const m = text.match(/^\/([a-zA-Z0-9_]+)/);
    if (m) msg.entities = [{ type: "bot_command", offset: 0, length: m[0].length }];
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": LOCAL_SECRET },
      body: JSON.stringify({ update_id: updateId++, message: msg }),
    });
    return res;
  };
  const dbLang = async (): Promise<string | null> => {
    const c = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL });
    await c.connect();
    try {
      const r = await c.query("SELECT lang FROM chat_langs WHERE chat_id = $1", [QA_CHAT]);
      return r.rowCount ? (r.rows[0].lang as string) : null;
    } finally {
      await c.end();
    }
  };

  say(`\n=== HTTP lane: ${base}`);

  // Gate 1: GET health probe
  const h0 = await fetch(base, { method: "GET" });
  const b0 = (await h0.json().catch(() => ({}))) as { status?: string };
  const ok0 = h0.status === 200 && b0.status === "ok";
  record("http", "GET health probe → 200 {status:'ok'}", ok0, `status=${h0.status}`);
  failures += ok0 ? 0 : 1;

  // Gate 2: secret-token auth contract (405 without token, 405 with wrong token)
  const p = (body: unknown, hdr?: Record<string, string>) =>
    fetch(base, { method: "POST", headers: { "content-type": "application/json", ...hdr }, body: JSON.stringify(body) });
  const noTok = await p({ update_id: 1, message: { text: "/start" } });
  const badTok = await p({ update_id: 2, message: { text: "/start" } }, { "x-telegram-bot-api-secret-token": "definitely-wrong" });
  record("http", "POST without secret token → 405", noTok.status === 405, `status=${noTok.status}`);
  failures += noTok.status === 405 ? 0 : 1;
  record("http", "POST with wrong secret token → 405", badTok.status === 405, `status=${badTok.status}`);
  failures += badTok.status === 405 ? 0 : 1;
  await noTok.body?.cancel().catch(() => {});
  await badTok.body?.cancel().catch(() => {});

  say("\n--- /start + /help (HTTP, zh default)");
  for (const cmd of ["/start", "/help"]) {
    const r = await postUpdate(cmd);
    const ok = r.status === 200;
    record("http", `${cmd} → HTTP 200 through prod route`, ok, `status=${r.status}`);
    failures += ok ? 0 : 1;
  }

  // The 45-query matrix: 3 display languages × (15 pairs). Each /lang is
  // proven by reading the chat_langs row back from Neon.
  for (const lang of ["zh", "en", "ja"] as const) {
    const rl = await postUpdate(`/lang ${lang}`);
    const stored = await dbLang();
    const okLang = rl.status === 200 && stored === lang;
    record("http", `/lang ${lang} POSTed + chat_langs row reads back '${lang}'`, okLang, `status=${rl.status} stored=${stored}`);
    failures += okLang ? 0 : 1;

    for (const fp of matrix.found) {
      const r = await postUpdate(`/check ${fp.pair[0]} ${fp.pair[1]}`);
      const ok = r.status === 200;
      record("http", `[${lang}] /check ${fp.pair.join(" ")} (${fp.expected}) → HTTP 200`, ok, `status=${r.status}`);
      failures += ok ? 0 : 1;
    }
    for (const np of matrix.notfound) {
      const r = await postUpdate(`/check ${np.pair[0]} ${np.pair[1]}`);
      const ok = r.status === 200;
      record("http", `[${lang}] /check ${np.pair.join(" ")} (notfound) → HTTP 200`, ok, `status=${r.status}`);
      failures += ok ? 0 : 1;
    }
  }

  // /lang no-arg through HTTP (reports current; current = ja from the last
  // matrix leg — DB ground truth already pinned above).
  const rn = await postUpdate("/lang");
  const storedNow = await dbLang();
  record("http", `/lang (no arg) POSTed → HTTP 200, stored lang still '${storedNow}'`, rn.status === 200 && storedNow === "ja", `status=${rn.status} stored=${storedNow}`);
  failures += rn.status === 200 && storedNow === "ja" ? 0 : 1;

  // Cleanup the QA chat's row.
  const c = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL });
  await c.connect();
  await c.query("DELETE FROM chat_langs WHERE chat_id = $1", [QA_CHAT]);
  await c.end();

  say(`\nHTTP lane: ${results.filter((r) => r.lane === "http").length - failures}/${results.filter((r) => r.lane === "http").length} pass`);
  return failures;
}

// ── reply-text lane: simulate-check.ts pattern (in-process, stubbed send) ─
async function replyLane(): Promise<number> {
  const { createBot, FALLBACK_BOT_INFO } = await import("../lib/bot.ts");
  const {
    EMERGENCY_LINE,
    DISCLAIMER_LINE,
    NOT_IN_DB_ZH,
    NOT_IN_DB_EN,
    NOT_IN_DB_JA,
    SEVERITY_BADGE,
    SEVERITY_BADGE_JA,
  } = await import("../lib/render.ts");
  const { Api } = await import("grammy");

  const bot = createBot("ddicbot:local-placeholder", FALLBACK_BOT_INFO);
  const sent: string[] = [];
  let nextId = 1;
  type Proto = { sendMessage: Function };
  const proto = Api.prototype as unknown as Proto;
  const orig = proto.sendMessage;
  proto.sendMessage = function (
    this: unknown,
    chatId: number,
    text: string,
  ) {
    sent.push(typeof text === "string" ? text : String(text));
    return Promise.resolve({
      message_id: nextId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" as const },
      text,
    });
  };

  let updateId = 900_000;
  const QA_CHAT = 780_666_002;
  const oneReply = async (text: string): Promise<string> => {
    sent.length = 0;
    const msg: Record<string, unknown> = {
      message_id: updateId,
      from: { id: QA_CHAT, is_bot: false, first_name: "QA", username: "qa_matrix" },
      chat: { id: QA_CHAT, type: "private", first_name: "QA" },
      date: Math.floor(Date.now() / 1000),
      text,
    };
    const m = text.match(/^\/([a-zA-Z0-9_]+)/);
    if (m) msg.entities = [{ type: "bot_command", offset: 0, length: m[0].length }];
    // Awaiting handleUpdate = the update is fully processed (same contract
    // as scripts/simulate-check.ts).
    await bot.handleUpdate({ update_id: updateId++, message: msg } as never);
    return sent[sent.length - 1] ?? "";
  };

  const FORBIDDEN = [/no interaction/i, /\bsafe\b/i, /no problem/i];
  let failures = 0;
  let checkCount = 0;

  const assertCheck = (reply: string, lang: "zh" | "en" | "ja", fp?: FoundPair, np?: NotFoundPair): string[] => {
    const problems: string[] = [];
    checkCount++;
    if (!reply.includes(EMERGENCY_LINE)) problems.push("missing EMERGENCY_LINE");
    if (!reply.includes(DISCLAIMER_LINE)) problems.push("missing DISCLAIMER_LINE");
    for (const re of FORBIDDEN) if (re.test(reply)) problems.push(`forbidden wording present: ${re}`);
    if (fp) {
      const badge = lang === "ja" ? SEVERITY_BADGE_JA[fp.expected] : SEVERITY_BADGE[fp.expected];
      if (!reply.includes(badge)) problems.push(`missing badge '${badge}' for ${fp.expected}`);
      if (lang === "ja") {
        if (fp.expected === "Major" && !reply.includes("🔴 重大")) problems.push("ja Major badge 重大 missing");
      }
      const mech =
        lang === "zh"
          ? fp.mechanismZh
            ? "机制: "
            : fp.mechanismEn
              ? "机制说明（英文）: "
              : "来源未提供机制说明"
          : lang === "en"
            ? fp.mechanismEn
              ? "Mechanism: "
              : "No mechanism text on record"
            : fp.mechanismJa
              ? "仕組み: "
              : fp.mechanismEn
                ? "Mechanism: "
                : "No mechanism text on record";
      if (!reply.includes(mech)) problems.push(`missing mechanism shape '${mech}'`);
    }
    if (np) {
      const pin = lang === "zh" ? NOT_IN_DB_ZH : lang === "en" ? NOT_IN_DB_EN : NOT_IN_DB_JA;
      if (!reply.includes(pin)) problems.push(`missing EXACT notfound line for ${lang}`);
      if (!reply.includes(NOT_IN_DB_ZH)) problems.push("zh notfound line dropped");
      if (!reply.includes(NOT_IN_DB_EN)) problems.push("en notfound line dropped");
      if (!reply.includes(NOT_IN_DB_JA)) problems.push("ja notfound line dropped");
    }
    return problems;
  };

  try {
    say("\n=== Reply lane (in-process, stubbed outbound, live DB)");

    // Baseline: fresh chat reads zh default.
    const rDef = await oneReply("/lang");
    record("reply", "/lang no-arg on fresh chat reports 'Current: zh' + footer", rDef.includes("Current: zh") && rDef.includes(EMERGENCY_LINE) && rDef.includes(DISCLAIMER_LINE), rDef.slice(0, 120));

    // Invalid /lang value is rejected (no DB write).
    const rInv = await oneReply("/lang klingon");
    record("reply", "/lang klingon rejected with usage hint", rInv.includes("Invalid") && rInv.includes(EMERGENCY_LINE), rInv.slice(0, 120));

    // /start and /help carry the footer + command list.
    const rStart = await oneReply("/start");
    record("reply", "/start: usage + /lang en|zh|ja + command list + both mandatory lines", rStart.includes("/check") && rStart.includes("/lang") && rStart.includes("/help") && rStart.includes(EMERGENCY_LINE) && rStart.includes(DISCLAIMER_LINE), rStart.slice(0, 160));
    const rHelp = await oneReply("/help");
    record("reply", "/help: lists /check /lang /start + both mandatory lines", rHelp.includes("/check") && rHelp.includes("/lang") && rHelp.includes("/start") && rHelp.includes(EMERGENCY_LINE) && rHelp.includes(DISCLAIMER_LINE), rHelp.slice(0, 160));

    // ── the 45-query language matrix ──
    for (const lang of ["zh", "en", "ja"] as const) {
      const rLang = await oneReply(`/lang ${lang}`);
      const okLang = rLang.includes(`Language set to: ${lang}`) && rLang.includes(EMERGENCY_LINE) && rLang.includes(DISCLAIMER_LINE);
      record("reply", `/lang ${lang} confirms + footer`, okLang, rLang.slice(0, 100));
      if (!okLang) failures++;

      const rCur = await oneReply("/lang");
      const okCur = rCur.includes(`Current: ${lang}`);
      record("reply", `/lang (no arg) after /lang ${lang} reports Current: ${lang}`, okCur, rCur.slice(0, 120));
      if (!okCur) failures++;

      for (const fp of matrix.found) {
        const reply = await oneReply(`/check ${fp.pair[0]} ${fp.pair[1]}`);
        const problems = assertCheck(reply, lang, fp);
        if (problems.length) failures++;
        record("reply", `[${lang}] /check ${fp.pair.join(" ")} → ${fp.expected} badge + mechanism shape + footer`, problems.length === 0, problems.join("; "));
      }
      for (const np of matrix.notfound) {
        const reply = await oneReply(`/check ${np.pair[0]} ${np.pair[1]}`);
        const problems = assertCheck(reply, lang, undefined, np);
        if (problems.length) failures++;
        record("reply", `[${lang}] /check ${np.pair.join(" ")} → EXACT notfound lines (no 'no interaction')`, problems.length === 0, problems.join("; "));
      }
    }

    // ── /lang switch mid-conversation (explicit): same pair, chrome changes
    say("\n--- /lang switch mid-conversation: warfarin aspirin (Major)");
    const pair = "warfarin aspirin";
    const sw1 = await (async () => {
      await oneReply("/lang zh");
      return oneReply(`/check ${pair}`);
    })();
    const p1 = assertCheck(sw1, "zh", matrix.found.find((f) => f.pair.join(" ") === pair)!);
    record("reply", "switch: /lang zh → pair renders zh chrome (🔴 Major / 严重) + no-mechanism zh placeholder", p1.length === 0, p1.join("; "));
    if (p1.length) failures++;

    const sw2 = await (async () => {
      await oneReply("/lang ja");
      return oneReply(`/check ${pair}`);
    })();
    const p2 = assertCheck(sw2, "ja", matrix.found.find((f) => f.pair.join(" ") === pair)!);
    const jaChanged = !sw2.includes("🔴 Major / 严重") && sw2.includes("🔴 重大");
    if (!jaChanged) p2.push("chrome did not change to ja badge");
    record("reply", "switch: /lang ja → same pair now renders ja chrome (🔴 重大)", p2.length === 0, p2.join("; "));
    if (p2.length) failures++;

    const sw3 = await (async () => {
      await oneReply("/lang en");
      return oneReply(`/check ${pair}`);
   })();
    const p3 = assertCheck(sw3, "en", matrix.found.find((f) => f.pair.join(" ") === pair)!);
    const enChanged = !sw3.includes("🔴 重大") && sw3.includes("🔴 Major / 严重");
    if (!enChanged) p3.push("chrome did not change to en badge");
    record("reply", "switch: /lang en → same pair renders en chrome (🔴 Major / 严重)", p3.length === 0, p3.join("; "));
    if (p3.length) failures++;

    // ja notfound chrome on the spot (a notfound pair rendered after switching to ja):
    const sw4 = await (async () => {
      await oneReply("/lang ja");
      return oneReply(`/check metformin sitagliptin`);
    })();
    const np4 = matrix.notfound.find((n) => n.pair.join(" ") === "metformin sitagliptin")!;
    const p4 = assertCheck(sw4, "ja", undefined, np4);
    record("reply", "switch: ja notfound line EXACT in a post-switch reply", p4.length === 0, p4.join("; "));
    if (p4.length) failures++;

    // Unresolvable path carries the footer + notfound lines in ja (render path check):
    const sw5 = await (async () => {
      await oneReply("/lang ja");
      return oneReply("/check zzzzqqqq aaaa");
    })();
    const p5 = [
      !sw5.includes("識別できませんでした") ? "ja re-prompt missing" : "",
      !sw5.includes(NOT_IN_DB_JA) ? "ja notfound line missing" : "",
      !sw5.includes(EMERGENCY_LINE) ? "EMERGENCY_LINE missing" : "",
      !sw5.includes(DISCLAIMER_LINE) ? "DISCLAIMER_LINE missing" : "",
    ].filter(Boolean);
    record("reply", "ja unresolvable /check: re-prompt + all notfound lines + both mandatory lines", p5.length === 0, p5.join("; "));
    if (p5.length) failures++;

    // Usage path (one token) carries both mandatory lines:
    const sw6 = await oneReply("/check aspirin");
    const p6 = [
      !sw6.includes("/check <drug1> <drug2>") ? "usage line missing" : "",
      !sw6.includes(EMERGENCY_LINE) ? "EMERGENCY_LINE missing" : "",
      !sw6.includes(DISCLAIMER_LINE) ? "DISCLAIMER_LINE missing" : "",
    ].filter(Boolean);
    record("reply", "usage path /check aspirin: usage line + both mandatory lines", p6.length === 0, p6.join("; "));
    if (p6.length) failures++;
  } finally {
    proto.sendMessage = orig;
    await (await import("../lib/db.ts")).getPool().end();
  }

  say(`\nReply lane: /check queries asserted = ${checkCount} (expect 45 = 10×3 + 5×3)`);
  return failures;
}

// ── main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Matrix ground-truth re-verification against Neon before spending minutes.
  const c = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL });
  await c.connect();
  let drift = 0;
  for (const fp of matrix.found) {
    const r = await c.query(
      "SELECT severity FROM ddi_pairs WHERE (drug_a_ingredient=$1 AND drug_b_ingredient=$2) OR (drug_a_ingredient=$2 AND drug_b_ingredient=$1)",
      [fp.ids[0], fp.ids[1]],
    );
    if (r.rowCount !== 1 || r.rows[0].severity !== fp.expected) {
      drift++;
      say(`MATRIX DRIFT: ${fp.pair.join(" ")} = ${r.rowCount ? r.rows[0].severity : "MISSING"}, expected ${fp.expected}`);
    }
  }
  for (const np of matrix.notfound) {
    const r = await c.query(
      "SELECT 1 FROM ddi_pairs WHERE (drug_a_ingredient=$1 AND drug_b_ingredient=$2) OR (drug_a_ingredient=$2 AND drug_b_ingredient=$1)",
      [np.ids[0], np.ids[1]],
    );
    if (r.rowCount !== 0) {
      drift++;
      say(`MATRIX DRIFT: ${np.pair.join(" ")} now EXISTS in ddi_pairs`);
    }
  }
  await c.end();
  if (drift) {
    say(`Matrix drift (${drift}) — update docs/final-qa-pairs.json against the live DB.`);
    process.exit(1);
  }
  say(`Matrix re-verified against live Neon: ${matrix.found.length} found + ${matrix.notfound.length} notfound OK`);

  say("\n=== Building (npm run build)");
  const build = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8", timeout: 600_000 });
  const buildOk = build.status === 0;
  record("gate", "npm run build green", buildOk, (build.stderr || build.stdout || "").slice(-400));
  if (!buildOk) {
    say("\nBuild failed — aborting before server start.");
    finish();
    process.exit(1);
  }
  say((build.stdout || "").split("\n").slice(-8).join("\n"));

  const port = await freePort();
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NEON_DATABASE_URL: process.env.NEON_DATABASE_URL,
    TELEGRAM_WEBHOOK_SECRET: LOCAL_SECRET,
  };
  delete serverEnv.DDICBOT_BOT_TOKEN; // passive local bot: no real Bot API traffic
  say(`\n=== Starting local prod server on 127.0.0.1:${port} (next start, passive bot)`);
  const child = spawn("npm", ["run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOut = "";
  child.stdout?.on("data", (d) => (serverOut += d));
  child.stderr?.on("data", (d) => (serverOut += d));
  const kill = () => {
    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 4000);
    } catch { /* already dead */ }
  };
  process.on("exit", kill);

  // Wait for readiness (GET 200).
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/tg-webhook`, { method: "GET" });
      if (r.status === 200) ready = true;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) break;
  }
  if (!ready) {
    say("server did not become ready:\n" + tail(serverOut, 1200));
    record("gate", "next start readiness (GET 200 within 60s)", false, tail(serverOut, 400));
    kill();
    finish();
    process.exit(1);
  }
  record("gate", "next start: GET /api/tg-webhook 200 within 60s", true);

  let httpFail = 0;
  try {
    httpFail = await httpLane(port);
  } finally {
    kill();
    // Give the child a moment to die before finishing.
    await sleep(1500);
    say("\n(local server stopped)");
  }

  const replyFail = await replyLane();

  finish();
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  say(`\n================= ${passed}/${total} QA cases pass (http failures ${httpFail}, reply failures ${replyFail}) =================`);
  process.exit(passed === total ? 0 : 1);
}

function tail(s: string, n: number): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}

function finish(): void {
  try {
    mkdirSync(join(root, "docs", "e2e"), { recursive: true });
    const total = results.length;
    const passed = results.filter((r) => r.pass).length;
    const md: string[] = [
      "# DDICBot P3 final-QA — local production matrix run",
      "",
      `Run at: ${new Date().toISOString()}`,
      `Target: local next start on a free 127.0.0.1 port (real npm run build output); pair matrix docs/final-qa-pairs.json re-verified against the live Neon ddi_pairs at startup.`,
      "",
      "Method: HTTP lane POSTs crafted Telegram updates (bot_command entities exactly as the Bot API emits them) to the prod route with a locally generated `x-telegram-bot-api-secret-token`; /lang effects are proven by reading the `chat_langs` row back from Neon. Reply-text lane drives the SAME crafted updates through the same grammY bot in-process with only the outbound `Api.prototype.sendMessage` stubbed (the scripts/simulate-check.ts pattern) — webhook HTTP cannot return reply text; Telegram webhooks reply `{ok:true}` at most.",
      "",
      `Result: **${passed}/${total} cases pass**${passed === total ? "" : " — FAILURE"}`,
      "",
      "| lane | case | verdict | detail |",
      "|------|------|---------|--------|",
      ...results.map(
        (r) =>
          `| ${r.lane} | ${r.name} | ${r.pass ? "PASS" : "**FAIL**"} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ") || "—"} |`,
      ),
      "",
      "Pinned not-found strings asserted verbatim in every /check not-found reply of each language:",
      `- zh: ${"数据库未收录该组合，不代表无相互作用。"}`,
      `- en: ${"This combination is not in our database"}`,
      `- ja: ${"この組み合わせはデータベースに収録されていません"}`,
      "Mandatory lines asserted in every reply: `EMERGENCY_LINE` + `DISCLAIMER_LINE`; forbidden wording ('no interaction'/'safe'/'no problem') asserted absent.",
      "",
    ];
    writeFileSync(join(root, "docs", "qa-matrix-log.md"), md.join("\n"));
    writeFileSync(
      join(root, "docs", "e2e", "qa-matrix-summary.json"),
      JSON.stringify(
        {
          run_at: new Date().toISOString(),
          target: "local next start (127.0.0.1, free port) — prod-shaped stack",
          method:
            "HTTP lane: crafted updates POSTed to the built route with local secret-token; /lang proven via chat_langs DB read-back. Reply lane: simulate-check.ts in-process stub of outbound sendMessage; live Neon resolution+DDI. Matrix severities re-verified against ddi_pairs at startup.",
          totals: { cases: total, pass: passed, fail: total - passed },
          checks_by_lane: {
            http: results.filter((r) => r.lane === "http").length,
            reply: results.filter((r) => r.lane === "reply").length,
            gate: results.filter((r) => r.lane === "gate").length,
          },
          results,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    say("WARNING: could not write QA report: " + String(err));
  }
}

main().catch((err) => {
  say("harness fatal: " + String(err instanceof Error ? err.stack : err));
  finish();
  process.exit(3);
});
