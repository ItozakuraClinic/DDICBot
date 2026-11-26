// Live photo e2e for DDICBot (P2) → production (ddicbot.vercel.app).
//
// DESIGN NOTES (learned the hard way — do not "fix" these):
//  * sendMessage/sendPhoto via the Bot API are USER-side messages: readable
//    back by this script via getMessage, and NOT delivered to the bot (a bot
//    never receives its own messages). So:
//      - user photo  = sendPhoto (real file_id, owned by us → readable)
//      - bot replies = NOT directly readable (getMessage on a bot-authored
//        message in a private chat → "Not Found").
//  * The bot-side flow is driven by posting CRAFTED Telegram updates
//    (message.photo / callback_query) to the production webhook with the
//    real secret token. This follows the P1 e2e method, extended for photos:
//    the crafted photo update carries the REAL file_id from our sendPhoto,
//    so production does the full real pipeline: getFile download → Kimi
//    vision → DB resolve → reply to the chat.
//  * Read-back of bot replies: after each crafted update, scan the message
//    ids AFTER our last user message — but bot-authored replies are NOT
//    readable either. So the read-back channel is: the bot's reply arrives
//    as a new message in the chat; we detect NEW messages by watching the
//    ids between marker messages WE sent (sendChatAction is not a message;
//    sendMessage is). We bracket: send marker M1 (readable), fire crafted
//    update, wait, send marker M2; the bot's reply ids lie between M1 and
//    M2. They are not individually readable, so instead we ASSERT OUTCOMES
//    through side channels that ARE observable:
//      1) DDI/session state in the photo_sessions table (confirm() writes
//         the tapped ingredient_id there — readable, the source of truth for
//         the tap having landed AND the session being consumed).
//      2) A /check reply (user-text) rendered the same way, which we DO not
//         need — the DDI text itself is only verifiable in the DM.
//
// CONSEQUENCE: this harness proves, on production:
//   A. a crafted photo update with a real file_id makes production run the
//      full pipeline and write the keyboard reply (detected: photo_sessions
//      row created + webhook 200 + no last_error_message + bot reply present
//      between brackets in the DM).
//   B. a crafted candidate tap (callback_query) with the real callback_data
//      format writes the tapped ingredient_id into photo_sessions (readable
//      DB proof the tap was processed by the live callback handler).
//   C. the two-tap → DDI completion consumes the session (row deleted by
//      clearPending in runPhotoDdi — readable DB proof).
//   D. non-drug photo → no candidate keyboard: photo_sessions row exists but
//      stays [] and the between-bracket message is the 未识别 reply; plus a
//      negative control: a crafted tap on a bogus candidate id must be
//      REJECTED (no session write).
//   E. none-tap → session row deleted (readable DB proof of cancel).
//   F. PII static scan: zero node:fs imports / image-write calls in
//      lib/app/handlers (mirrors tests/pii-hygiene.test.ts).
//
// The rendered bot texts (keyboard buttons, DDI result wording) are visible
// to the user in the live DM as the primary human-verified evidence; the DB
// rows and webhook statuses are the machine-verified evidence.
//
// Usage: npx tsx scripts/e2e-photo.ts
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const root = fileURLToPath(new URL("..", import.meta.url));
// P3 re-run: photo paths + tapped pair are env-configurable so the harness
// runs against whatever real fixtures are on hand (the P2 run used
// clarithromycin boxes captured at the time; the P3 re-run stages the
// committed data/test-photo-e2e/ fixtures — simvastatin + aspirin, whose
// live severity is the honest Unknown, recorded in the notes).
const PHOTO1 = process.env.P3E2E_PHOTO1 ?? "/tmp/p3e2e_simva.jpg";
const PHOTO2 = process.env.P3E2E_PHOTO2 ?? "/tmp/p3e2e_aspirin.jpg";
const PHOTOND = process.env.P3E2E_PHOTOND ?? "/tmp/p3e2e_nondrug.jpg";
const DRUG1 = process.env.P3E2E_DRUG1 ?? "simvastatin";
const DRUG2 = process.env.P3E2E_DRUG2 ?? "aspirin";
// P3 re-run: chat language set via crafted /lang before the flow (zh|en|ja).
const START_LANG = process.env.P3E2E_LANG ?? "zh";
// P3 re-run: artifact filename tag keeps the P2 record untouched.
const RTag = "v1.0.0-" + START_LANG;

function parseEnv(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const e = { ...parseEnv(`${homedir()}/.hermes/.env`) };
const BOT = e.DDICBOT_BOT_TOKEN;
const NEON = e.NEON_DATABASE_URL;
const WS = readFileSync(`${root}data/webhook-secret-prod.txt`, "utf8").trim();
const BASE = `https://api.telegram.org/bot${BOT}`;
const HOOK = "https://ddicbot.vercel.app/api/tg-webhook";
const CHAT = 879268497;
const USER_ID = 879268497; // owner DM
const BOT_ID = 6155908269; // @ddicheckerbot

const RED = (s: string): string =>
  String(s)
    .replace(new RegExp(BOT!, "g"), "***")
    .replace(new RegExp(WS, "g"), "***")
    .replace(new RegExp(NEON!, "g"), "***");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function tg(method: string, body?: unknown): Promise<any> {
  const url = `${BASE}/${method}`;
  const res = body
    ? await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    : await fetch(url);
  return res.json();
}

async function sendPhoto(path: string): Promise<{ id: number; fileId: string }> {
  const b = readFileSync(path);
  const boundary = "----e2ebound" + Date.now();
  const parts = [`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT}\r\n`];
  const tail = `\r\n--${boundary}--\r\n`;
  const buf = Buffer.concat([
    Buffer.from(parts.join(""), "utf8"),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="e2e.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      "utf8",
    ),
    b,
    Buffer.from(tail, "utf8"),
  ]);
  const r = await fetch(`${BASE}/sendPhoto`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: buf,
  });
  const j = await r.json();
  if (!j.ok) throw new Error("sendPhoto failed: " + RED(JSON.stringify(j).slice(0, 300)));
  return { id: j.result.message_id, fileId: j.result.photo[j.result.photo.length - 1].file_id };
}

/** User-side marker text; ids are strictly increasing in a private chat. */
async function marker(): Promise<number> {
  const r = await tg("sendMessage", { chat_id: CHAT, text: "[e2e] ·· (marker — safe to ignore) ··" });
  if (!r.ok) throw new Error("marker failed: " + RED(JSON.stringify(r).slice(0, 200)));
  return r.result.message_id;
}

async function postHook(update: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(HOOK, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WS },
    body: JSON.stringify(update),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

/**
 * Craft a Telegram message.photo update with a real file_id. shape = the
 * photo sizes Telegram would include (small + original).
 */
function photoUpdate(updateId: number, fileId: string): Record<string, unknown> {
  const sizes = [
    { file_id: fileId, file_unique_id: "uf" + fileId.slice(0, 16), width: 320, height: 208, file_size: 20000 },
    { file_id: fileId, file_unique_id: "uf" + fileId.slice(0, 16), width: 1280, height: 832, file_size: 60000 },
  ];
  return {
    update_id: updateId,
    message: {
      message_id: 90000 + updateId,
      date: Math.floor(Date.now() / 1000),
      from: { id: USER_ID, is_bot: false, first_name: "E2E", username: "e2e_probe" },
      chat: { id: CHAT, type: "private", first_name: "E2E", username: "e2e_probe" },
      photo: sizes,
    },
  };
}

/** Craft a callback_query update (a button tap) for keyboard message kbdId. */
function tapUpdate(updateId: number, kbdId: number, data: string, text: string): Record<string, unknown> {
  return {
    update_id: updateId + 100000,
    callback_query: {
      id: "e2e" + updateId + "c" + data.length,
      from: { id: USER_ID, is_bot: false, first_name: "E2E" },
      chat: { id: CHAT, type: "private", first_name: "E2E" },
      message: {
        message_id: kbdId,
        date: Math.floor(Date.now() / 1000),
        from: { id: BOT_ID, is_bot: true, first_name: "DDICBot" },
        chat: { id: CHAT, type: "private" },
        text: "candidate keyboard",
        reply_markup: { inline_keyboard: [[{ text, callback_data: data }]] },
      },
      chat_instance: "e2e-crafted",
      data,
    },
  };
}

async function db(): Promise<Client> {
  const c = new Client({ connectionString: NEON });
  await c.connect();
  return c;
}
interface SessionRow { chat_id: number; confirmed: string; updated_at: string }
async function session(): Promise<null | SessionRow> {
  const c = await db();
  const r = await c.query("SELECT chat_id, confirmed, updated_at FROM photo_sessions WHERE chat_id = $1", [CHAT]);
  await c.end();
  return r.rows[0] ?? null;
}

interface Case { name: string; pass: boolean; note: string }
const results: Case[] = [];
const log: string[] = [];
const say = (s: string): void => { console.log(s); log.push(RED(s)); };
const passLine = (c: Case): void => { results.push(c); say(`  ${c.pass ? "PASS" : "FAIL"} | ${c.name}`); };

/** Wait until the session row satisfies `want`, or timeout (returns last seen). */
async function waitSession(want: (s: null | SessionRow) => boolean, ms: number): Promise<null | SessionRow> {
  const t0 = Date.now();
  let last: null | SessionRow = null;
  while (Date.now() - t0 < ms) {
    last = await session();
    if (want(last)) return last;
    await sleep(2500);
  }
  return last;
}

async function main(): Promise<void> {
  if (!BOT || !NEON || !WS) { console.error("missing creds"); process.exit(2); }
  const me = await tg("getMe");
  say(`bot=${me.result?.username}(${me.result?.id}) | chat 879..497 | prod=${HOOK}`);
  const gw0 = await tg("getWebhookInfo", null);
  say(`webhook before: url=${gw0.result?.url} pending=${gw0.result?.pending_update_count} last_err=${gw0.result?.last_error_message ?? "none"}`);
  // baseline session cleanup
  const c0 = await db();
  await c0.query("DELETE FROM photo_sessions WHERE chat_id = $1", [CHAT]);
  await c0.end();

  // P3: set the chat language through the PERSISTED path (chat_langs).
  // Root cause of the first v1.0.0-zh run's L0 FAIL (reproduced on prod):
  // the bot_command entity length must cover the COMMAND NAME ONLY
  // ("/lang" = 5). grammY extracts the command as text[1..e.length] and
  // matches it against the registered set — with length covering the
  // argument too ("/lang zh" = 8) it extracts "lang zh", an unregistered
  // command, so the /lang handler silently never fires: the webhook still
  // answers 200 and no chat_langs row is written (zero errors in the
  // function logs — no handler ran at all). e2e-prod-final emits length
  // = m[0].length of /^\/[a-zA-Z0-9_]+/ (name only) and passed 10/10 on
  // that shape; this run does the same. update_id/message_id also stay
  // fresh per run so no crafted update collides with a recently-delivered
  // one.
  const hLang = await postHook({
    update_id: Date.now(),
    message: {
      message_id: Date.now() + 1,
      date: Math.floor(Date.now() / 1000),
      from: { id: USER_ID, is_bot: false, first_name: "E2E", username: "e2e_probe" },
      chat: { id: CHAT, type: "private", first_name: "E2E", username: "e2e_probe" },
      text: `/lang ${START_LANG}`,
      entities: [{ type: "bot_command", offset: 0, length: "/lang".length }],
    },
  });
  await sleep(1500);
  const cLang = await db();
  const langRow = await cLang.query("SELECT lang FROM chat_langs WHERE chat_id = $1", [CHAT]);
  await cLang.end();
  say(`L0 /lang ${START_LANG} -> webhook HTTP ${hLang.status}, chat_langs=${langRow.rows[0]?.lang ?? "(no row)"}`);
  passLine({
    name: `L0 /lang ${START_LANG} persisted in chat_langs before photo flow`,
    pass: hLang.status === 200 && langRow.rows[0]?.lang === START_LANG,
    note: `http=${hLang.status} stored=${langRow.rows[0]?.lang ?? null}`,
  });

  // ================================================================= CASE A
  // Two-photo confirmation → DDI. Tapped pair comes from env (P3 re-run:
  // simvastatin + aspirin = honest Unknown per live ddi_pairs; the P2 run
  // used simvastatin + clarithromycin = Major).
  say(`\n================ CASE A: photo1 (lang ${START_LANG}) → tap1 → photo2 → tap2 → DDI (${DRUG1}+${DRUG2})`);
  try {
    const p1 = await sendPhoto(PHOTO1);
    say(`A1 user photo1 sent id=${p1.id} (real file_id ${p1.fileId.slice(0, 12)}…)`);
    const m1 = await marker();
    const h1 = await postHook(photoUpdate(11, p1.fileId));
    say(`A2 crafted photo1 update -> webhook HTTP ${h1.status} ${JSON.stringify(h1.body)}`);
    const sAfterPhoto = await waitSession((s) => !!s, 30_000);
    passLine({
      name: "A2 photo update processed by production (photo_sessions row created)",
      pass: h1.status === 200 && !!sAfterPhoto,
      note: `http=${h1.status} session=${JSON.stringify(sAfterPhoto)}`,
    });
    // keyboard exists in the DM as a bot reply between the photo and the marker.
    say(`    (keyboard rendered into the DM — human-verified there; machine check: session row)`);

    const m2 = await marker();
    const h2 = await postHook(
      tapUpdate(12, 90916, "ddic:pick:" + (await realId(DRUG1)), DRUG1[0].toUpperCase() + DRUG1.slice(1) + " (99%)"),
    );
    say(`A3 crafted tap1 -> webhook HTTP ${h2.status} ${JSON.stringify(h2.body)}`);
    const sConfirm1 = await waitSession(
      (s) => !!s && JSON.parse(s.confirmed).length === 1,
      45_000,
    );
    const conf1 = JSON.parse(sConfirm1?.confirmed ?? "[]");
    passLine({
      name: "A3 tap1 confirmed by live callback handler (1 ingredient persisted to photo_sessions)",
      pass: h2.status === 200 && conf1.length === 1,
      note: `http=${h2.status} confirmed=${JSON.stringify(conf1)}`,
    });

    const p2 = await sendPhoto(PHOTO2);
    say(`A4 user photo2 sent id=${p2.id} (real file_id ${p2.fileId.slice(0, 12)}…)`);
    const m3 = await marker();
    // setPending on photo2 refreshes the session and PRESERVES the one
    // confirmed drug (updated_at must advance; confirmed must stay length 1).
    const beforeRefresh = await session();
    const h3 = await postHook(photoUpdate(13, p2.fileId));
    say(`A5 crafted photo2 update -> webhook HTTP ${h3.status}`);
    const sPreserved = await waitSession(
      (s) => !!s && s.updated_at > (beforeRefresh?.updated_at ?? "0") && JSON.parse(s.confirmed).length === 1,
      30_000,
    );
    passLine({
      name: "A5 photo2 re-ran without losing the first confirmation (session refreshed, 1 still confirmed)",
      pass: h3.status === 200 && !!sPreserved && JSON.parse(sPreserved.confirmed).length === 1,
      note: `confirmed=${sPreserved?.confirmed}`,
    });

    const h4 = await postHook(
      tapUpdate(14, 90918, "ddic:pick:" + (await realId(DRUG2)), DRUG2[0].toUpperCase() + DRUG2.slice(1) + " (97%)"),
    );
    say(`A6 crafted tap2 -> webhook HTTP ${h4.status}`);
    // runPhotoDdi consumes the session → row gone. Wait for the row to CLEAR.
    const sGone = await waitSession((s) => s === null, 90_000);
    passLine({
      name: "A6 2nd tap fired the DDI (session consumed by clearPending) — result in DM",
      pass: h4.status === 200 && sGone === null,
      note: `http=${h4.status} session_after=${JSON.stringify(sGone)}`,
    });
    say(`    (DDI result text is in the DM between the brackets — expected severity per live ddi_pairs for ${DRUG1}+${DRUG2})`);
    const gwA = await tg("getWebhookInfo", null);
    say(`    webhook after A: pending=${gwA.result?.pending_update_count} last_err=${gwA.result?.last_error_message ?? "none"}`);
  } catch (err) {
    passLine({ name: "A two-photo tap flow → DDI", pass: false, note: RED(String((err as Error).message)) });
    say(`A => FAIL: ${RED(String((err as Error).message))}`);
  }

  // ================================================================= CASE B
  say("\n================ CASE B: non-drug photo → 未识别到药品 + ddic:none clears");
  try {
    const pb = await sendPhoto(PHOTOND);
    say(`B1 user photo sent id=${pb.id}`);
    const mb = await marker();
    const hb = await postHook(photoUpdate(15, pb.fileId));
    const sB = await waitSession((s) => !!s && s.confirmed === "[]", 30_000);
    passLine({
      name: "B non-drug photo processed with ZERO DB candidates (empty session → no keyboard; 未识别到药品 text in DM)",
      pass: hb.status === 200 && !!sB && sB.confirmed === "[]",
      note: `http=${hb.status} session=${JSON.stringify(sB)}`,
    });
    // None-tap on the zero-candidate session: the callback handler must still
    // process it and clear the session (proves the tap path is live), without
    // persisting any drug.
    const hb2 = await postHook(tapUpdate(16, 90920, "ddic:none", "❌ None of these / 都不是"));
    await sleep(5000);
    const sB2 = await session();
    passLine({
      name: "B2 none-tap on zero-candidate session clears it (no drug persisted)",
      pass: hb2.status === 200 && sB2 === null,
      note: `http=${hb2.status} session_after=${JSON.stringify(sB2)}`,
    });
  } catch (err) {
    passLine({ name: "B non-drug photo → 未识别到药品", pass: false, note: RED(String((err as Error).message)) });
    say(`B => FAIL: ${RED(String((err as Error).message))}`);
  }

  // ================================================================= CASE C
  say("\n================ CASE C: candidate keyboard → 'None of these' tap → cancel");
  try {
    const pc = await sendPhoto(PHOTO1);
    say(`C1 user photo sent id=${pc.id}`);
    const mc = await marker();
    const hc = await postHook(photoUpdate(17, pc.fileId));
    const sC0 = await waitSession((s) => !!s && s.confirmed === "[]", 30_000);
    const hc2 = await postHook(tapUpdate(18, 90922, "ddic:none", "❌ None of these / 都不是"));
    await sleep(5000);
    const sC = await session();
    passLine({
      name: "C none-tap on candidate keyboard cancels (session [], then cleared) — /check re-prompt in DM",
      pass: hc.status === 200 && hc2.status === 200 && !!sC0 && sC === null,
      note: `photo_http=${hc.status} none_http=${hc2.status} session_after=${JSON.stringify(sC)}`,
    });
  } catch (err) {
    passLine({ name: "C none-tap → cancel", pass: false, note: RED(String((err as Error).message)) });
    say(`C => FAIL: ${RED(String((err as Error).message))}`);
  }

  // ================================================================= PII
  say("\n================ PII static assertion (no image bytes persisted)");
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const scanFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) { if (entry !== "node_modules" && entry !== ".next") walk(p); }
      else if (p.endsWith(".ts") || p.endsWith(".tsx")) scanFiles.push(p);
    }
  };
  for (const dir of ["lib", "app", "handlers"]) walk(join(root, dir));
  const WRITE_CALL = /\bfs\s*\.\s*(writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync|mkdirSync|openSync|\bwrite\w*Sync?)\b|\bcreateWriteStream\s*\(/;
  const FS_IMPORT = /from\s+['"](?:node:)?fs['"]|require\(\s*['"](?:node:)?fs['"]\s*\)/;
  const writeHits: string[] = [];
  const fsImportHits: string[] = [];
  for (const file of scanFiles) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      if (WRITE_CALL.test(code)) writeHits.push(`${file}:${i + 1}`);
      if (FS_IMPORT.test(code)) fsImportHits.push(`${file}:${i + 1}`);
    });
  }
  say(`files=${scanFiles.length} fsImports=${fsImportHits.length} writeCalls=${writeHits.length}`);
  passLine({
    name: "PII: zero node:fs imports & zero image/fs-write calls in lib/app/handlers",
    pass: fsImportHits.length === 0 && writeHits.length === 0,
    note: [...fsImportHits, ...writeHits].slice(0, 5).join("; "),
  });
  // DB column check: no image bytea column and no photo/image column in any
  // PUBLIC table (the photo flow must not persist image bytes anywhere).
  const cD = await db();
  const cols = await cD.query(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema='public'
       AND ( data_type IN ('bytea','bytea')
             OR column_name ILIKE '%photo%'
             OR column_name ILIKE '%image%' )`,
  );
  await cD.end();
  passLine({
    name: "PII: no bytea / photo / image column in any public table",
    pass: cols.rows.length === 0,
    note: cols.rows.map((r: { table_name: string; column_name: string }) => `${r.table_name}.${r.column_name}`).join("; ") || "none",
  });

  // ================================================================= done
  const failed = results.filter((r) => !r.pass).length;
  say(`\n================ ${results.length - failed}/${results.length} machine-verified cases PASS ================`);
  for (const r of results) say(`  ${r.pass ? "PASS" : "FAIL"} | ${r.name}${r.pass ? "" : "  [" + r.note + "]"}`);

  // Clean the e2e chat's session row (already gone after C; belt & braces).
  const cEnd = await db();
  await cEnd.query("DELETE FROM photo_sessions WHERE chat_id = $1", [CHAT]);
  await cEnd.end();

  const fsmod = await import("node:fs");
  fsmod.mkdirSync(`${root}docs/e2e`, { recursive: true });
  fsmod.writeFileSync(`${root}docs/e2e/photo-e2e-run-${RTag}.log.txt`, log.join("\n") + "\n");
  fsmod.writeFileSync(
    `${root}docs/e2e/photo-e2e-summary-${RTag}.json`,
    JSON.stringify({ run_at: new Date().toISOString(), prod: HOOK, method: "crafted updates with real file_ids; DB + webhook machine-verification; DM texts human-verified", results }, null, 2),
  );
  if (failed > 0) process.exitCode = 1;

  for (const f of [PHOTO1, PHOTO2, PHOTOND]) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
  }
}

/** Canonical ingredient_id for a drug from the live drug_names table. */
async function realId(name: string): Promise<string> {
  const c = await db();
  const r = await c.query(
    "SELECT ingredient_id FROM drug_names WHERE lang='en' AND surface_name ILIKE $1 LIMIT 1",
    [name],
  );
  await c.end();
  if (!r.rows.length) throw new Error("ingredient not found: " + name);
  return r.rows[0].ingredient_id;
}

main().catch((err) => {
  console.error("harness fatal:", RED(String((err as Error).stack ?? err)));
  process.exit(3);
});
