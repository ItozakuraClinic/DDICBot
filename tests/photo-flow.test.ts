/**
 * Photo-flow tests (P2T2) — node:test + tsx, same harness as P1.
 *
 * Two lanes:
 *  A) Static / pure: photo-state machine, candidate keyboard, and the
 *     NEVER-AUTO-MATCH invariant — a real photo update flowing through the
 *     real grammY bot with stubbed vision must fire ZERO ddi() calls.
 *  B) DB-backed (needs NEON_DATABASE_URL via scripts/_load-env.ts): the
 *     full tap-two-drugs → runPhotoDdi path against the live Neon branch,
 *     with DDI calls captured (not real) but real display names.
 */
import { loadHermesEnv } from "../scripts/_load-env.ts";
process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || loadHermesEnv().NEON_DATABASE_URL || "";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Bot } from "grammy";
import { Api } from "grammy";

import {
  _resetPhotoState,
  confirm,
  getPending,
  setPending,
  clearPending,
} from "../lib/photo-state.ts";
import {
  candidateKeyboard,
  handlePhotoCore,
  registerPhotoHandlers,
  runPhotoDdi,
  type PhotoDeps,
  type DdiDeps,
} from "../handlers/photo.ts";
import { FALLBACK_BOT_INFO } from "../lib/bot.ts";
import { EMERGENCY_LINE, DISCLAIMER_LINE } from "../lib/render.ts";
import type { DdiResult } from "../lib/ddi-query.ts";

const HAS_DB = Boolean(process.env.NEON_DATABASE_URL);

// ---------------------------------------------------------------------------
// A1. photo-state machine (DB-backed — registered only with the live DSN;
// the confirmation session lives in photo_sessions on purpose, because
// Vercel function instances are stateless and a photo + its follow-up tap
// can land on different instances).
// ---------------------------------------------------------------------------

if (HAS_DB) {
  test("photo-state: confirm records a tap and reports 1/2 (not ready)", async () => {
    await _resetPhotoState();
    void await setPending(101);
    const r1 = await confirm(101, "DDInter20", "aspirin");
    assert.ok(r1.ok && r1.pending);
    assert.equal(r1.readyForDdi, false);
    assert.equal(r1.confirmed.length, 1);
    const r2 = await confirm(101, "DDInter1675", "sinvastatin");
    assert.ok(r2.ok);
    assert.equal(r2.readyForDdi, true);
    assert.deepEqual(r2.confirmed.map((c) => c.id).sort(), ["DDInter1675", "DDInter20"]);
  });

  test("photo-state: duplicate tap is flagged, never double-counted", async () => {
    await _resetPhotoState();
    void await setPending(102);
    await confirm(102, "DDInter20", "aspirin");
    const again = await confirm(102, "DDInter20", "aspirin");
    assert.ok(again.ok);
    assert.ok(again.duplicate);
    assert.equal(again.readyForDdi, false);
    assert.equal((await getPending(102))!.confirmed.length, 1);
  });

  test("photo-state: tap with no live session is dropped (no phantom half-pair)", async () => {
    await _resetPhotoState();
    const r = await confirm(999, "DDInter20", "aspirin");
    assert.equal(r.ok, false);
    assert.equal(r.pending, false);
    assert.equal(r.readyForDdi, false);
  });

  test("photo-state: a second photo keeps the first confirmed drug (two-photo flow)", async () => {
    await _resetPhotoState();
    void await setPending(103);
    await confirm(103, "DDInter20", "aspirin");
    // second photo arrives: handlePhotoCore calls setPending again
    const s = await setPending(103);
    assert.equal(s.confirmed.length, 1);
    assert.equal(s.confirmed[0].id, "DDInter20");
  });

  test("photo-state: clearPending consumes the session", async () => {
    await _resetPhotoState();
    void await setPending(104);
    await clearPending(104);
    assert.equal(await getPending(104), undefined);
    const r = await confirm(104, "DDInter20", "aspirin");
    assert.equal(r.ok, false);
  });
}

// ---------------------------------------------------------------------------
// A2. candidate keyboard shape
// ---------------------------------------------------------------------------

test("candidateKeyboard: one row per candidate (≤5) + a 'none of these' row", () => {
  const cands = [1, 2, 3, 4, 5, 6].map((i) => ({
    ingredient_id: `X${i}`,
    db_name: `drug${i}`,
    llm_name: `drug${i}`,
    how: "exact" as const,
    confidence: 0.9,
  }));
  const kb = candidateKeyboard(cands);
  assert.equal(kb.inline_keyboard.length, 6); // 5 capped + none
  for (let i = 0; i < 5; i++) {
    const btn = kb.inline_keyboard[i][0];
    assert.equal(btn.callback_data, `ddic:pick:X${i + 1}`);
    assert.ok(btn.text.includes("90%"));
    assert.ok(btn.callback_data.length <= 64, "callback_data must stay ≤64 bytes");
  }
  assert.equal(kb.inline_keyboard[5][0].callback_data, "ddic:none");
  assert.ok(kb.inline_keyboard[5][0].text.includes("不是"));
});

// ---------------------------------------------------------------------------
// A3. NEVER-AUTO-MATCH + flow: real grammY bot, stubbed vision/download,
//     REAL photo_sessions DB (stubs would defeat the point that the session
//     survives in the DB). No DDI calls happen except via explicit taps.
// ---------------------------------------------------------------------------

function stubOutbound(): { sent: { text: string; reply_markup?: unknown }[] } {
  const sent: { text: string; reply_markup?: unknown }[] = [];
  const proto = Api.prototype as unknown as Record<string, Function>;
  proto.sendMessage = function (this: unknown, chatId: number, text: string, other?: unknown) {
    sent.push({ text: String(text), reply_markup: (other as { reply_markup?: unknown })?.reply_markup });
    return Promise.resolve({
      message_id: 1,
      date: 1,
      chat: { id: chatId ?? 42, type: "private" as const },
      text,
      reply_markup: (other as { reply_markup?: unknown })?.reply_markup,
    });
  };
  proto.answerCallbackQuery = function () {
    return Promise.resolve(true);
  };
  proto.editMessageText = function (
    this: unknown,
    _chatId: number,
    _msgId: number,
    text: string,
    other?: unknown,
  ) {
    sent.push({ text: String(text), reply_markup: (other as { reply_markup?: unknown })?.reply_markup });
    return Promise.resolve({ message_id: 1, date: 1 });
  };
  return { sent };
}

let _savedSend: Function | undefined;
let _savedAnswer: Function | undefined;
let _savedEdit: Function | undefined;
before(() => {
  const proto = Api.prototype as unknown as Record<string, Function>;
  _savedSend = proto.sendMessage;
  _savedAnswer = proto.answerCallbackQuery;
  _savedEdit = proto.editMessageText;
});
after(() => {
  const proto = Api.prototype as unknown as Record<string, Function>;
  if (_savedSend) proto.sendMessage = _savedSend;
  if (_savedAnswer) proto.answerCallbackQuery = _savedAnswer;
  if (_savedEdit) proto.editMessageText = _savedEdit;
});

function makePhotoUpdate(fileId: string, chatId: number): never {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      from: { id: chatId, is_bot: false, first_name: "Sim" },
      chat: { id: chatId, type: "private", first_name: "Sim" },
      date: Math.floor(Date.now() / 1000),
      photo: [{ file_id: fileId, file_unique_id: "u1", width: 900, height: 620, file_size: 30000 }],
    },
  } as never;
}

function makeCallbackUpdate(data: string, chatId: number, msgId: number): never {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    callback_query: {
      id: "cb1",
      from: { id: chatId, is_bot: false, first_name: "Sim" },
      chat: { id: chatId, type: "private", first_name: "Sim" },
      message: {
        message_id: msgId,
        chat: { id: chatId, type: "private" },
        date: 1,
        text: "keyboard msg",
        reply_markup: { inline_keyboard: [[{ text: "x", callback_data: data }]] },
      },
      date: 1,
      data,
    },
  } as never;
}

test("NEVER-AUTO-MATCH: photo update with zero taps fires ZERO ddi calls", async (t) => {
  if (!HAS_DB) t.skip("needs NEON_DATABASE_URL (photo_sessions table)");
  await _resetPhotoState();
  const ddiCalls: [string, string][] = [];
  const ddiDeps: DdiDeps = {
    ddi: async (a, b) => {
      ddiCalls.push([a, b]);
      return { found: true, severity: "Major", mechanism_en: null, pair_count: 1 };
    },
    names: async () => ({}),
  };
  const fakeBytes = new Uint8Array([1, 2, 3]);
  const photoDeps: PhotoDeps = {
    fetch: async () => ({ bytes: fakeBytes, mime: "image/jpeg" }),
    vision: async () => [
      { name: "Simvastatin", lang: "en", confidence: 0.99 },
      { name: "Zzz NotADrug", lang: "en", confidence: 0.5 },
    ],
    map: async () => [
      { ingredient_id: "DDInter1675", db_name: "sinvastatin (statin)", llm_name: "Simvastatin", how: "fuzzy", confidence: 0.99 },
    ],
    lang: () => "zh",
  };
  const { sent } = stubOutbound();
  // Bare Bot (NOT createBot): createBot auto-registers the LIVE photo
  // handler (real Bot API download + real Kimi vision). Unit tests register
  // only the stub-surface handlers so no network is touched.
  const bot = new Bot("ddicbot:local-placeholder", { botInfo: FALLBACK_BOT_INFO });
  registerPhotoHandlers(bot, { photo: photoDeps, ddi: ddiDeps });
  await bot.handleUpdate(makePhotoUpdate("FAKEFILE1", 501));
  assert.equal(ddiCalls.length, 0, "a photo with no user tap must NOT query DDI");
  // A keyboard with the (DB-validated only) candidate + none row was sent.
  assert.ok(sent.some((m) => (m.reply_markup as { inline_keyboard?: unknown[] })?.inline_keyboard));
  const kbMsg = sent.find((m) => (m.reply_markup as { inline_keyboard?: unknown[] })?.inline_keyboard)!;
  const kb = kbMsg.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.ok(kb.inline_keyboard.some((row) => row[0].callback_data === "ddic:pick:DDInter1675"));
  assert.ok(kb.inline_keyboard.some((row) => row[0].callback_data === "ddic:none"));
  // The unknown LLM fabrication ("Zzz NotADrug") never reached the keyboard:
  // only DB-confirmed ids become buttons.
  const allData = kb.inline_keyboard.map((r) => r[0].callback_data).join(",");
  assert.ok(!allData.includes("NotADrug"));
});

test("photo flow e2e (stubs): tap 1 → 1/2 prompt; tap 2 → DDI result; then session consumed", async (t) => {
  if (!HAS_DB) t.skip("needs NEON_DATABASE_URL (photo_sessions table)");
  await _resetPhotoState();
  const ddiCalls: [string, string][] = [];
  const ddiDeps: DdiDeps = {
    ddi: async (a, b) => {
      ddiCalls.push([a, b]);
      return { found: true, severity: "Major", mechanism_en: null, pair_count: 1 };
    },
    names: async (ids) =>
      Object.fromEntries(ids.map((id) => [id, { en: [id.toUpperCase()], zh: [`中文${id}`], ja: [] }])),
  };
  const firstPhoto: PhotoDeps = {
    fetch: async () => ({ bytes: new Uint8Array([9]), mime: "image/jpeg" }),
    vision: async () => [{ name: "Simvastatin", lang: "en", confidence: 0.99 }],
    map: async () => [
      { ingredient_id: "ID_A", db_name: "simvastatin", llm_name: "Simvastatin", how: "exact", confidence: 0.99 },
    ],
    lang: () => "zh",
  };
  const secondPhoto: PhotoDeps = {
    ...firstPhoto,
    vision: async () => [{ name: "Aspirin", lang: "en", confidence: 0.98 }],
    map: async () => [
      { ingredient_id: "ID_B", db_name: "aspirin", llm_name: "Aspirin", how: "exact", confidence: 0.98 },
    ],
  };
  const { sent } = stubOutbound();
  // Bare Bot — see the NEVER-AUTO-MATCH test for why createBot is avoided
  // here (it would add the live network-touching photo handler).
  const bot = new Bot("ddicbot:local-placeholder", { botInfo: FALLBACK_BOT_INFO });
  registerPhotoHandlers(bot, { photo: firstPhoto, ddi: ddiDeps });

  sent.length = 0;
  await bot.handleUpdate(makePhotoUpdate("F1", 601));
  assert.deepEqual(ddiCalls, []);

  const kbMsg = sent.find((m) => (m.reply_markup as { inline_keyboard?: unknown[] })?.inline_keyboard)!;
  const kb = kbMsg.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
  const pickA = kb.inline_keyboard.find((r) => r[0].callback_data === "ddic:pick:ID_A")!;

  sent.length = 0;
  await bot.handleUpdate(makeCallbackUpdate(pickA[0].callback_data, 601, 7));
  assert.equal(ddiCalls.length, 0, "one tap must NOT query DDI");
  assert.ok(sent[0].text.includes("1/2"));

  // second photo path: same chat, fresh candidate on a new keyboard
  sent.length = 0;
  const bot2 = new Bot("ddicbot:local-placeholder", { botInfo: FALLBACK_BOT_INFO });
  registerPhotoHandlers(bot2, { photo: secondPhoto, ddi: ddiDeps });
  await bot2.handleUpdate(makePhotoUpdate("F2", 601));
  const kb2Msg = sent.find((m) => (m.reply_markup as { inline_keyboard?: unknown[] })?.inline_keyboard)!;
  const kb2 = kb2Msg.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
  const pickB = kb2.inline_keyboard.find((r) => r[0].callback_data === "ddic:pick:ID_B")!;

  sent.length = 0;
  await bot2.handleUpdate(makeCallbackUpdate(pickB[0].callback_data, 601, 8));
  assert.equal(ddiCalls.length, 1, "the second distinct tap fires exactly one DDI call");
  assert.deepEqual([...ddiCalls[0]].sort(), ["ID_A", "ID_B"]);
  const result = sent[sent.length - 1].text;
  assert.ok(result.includes("🔴 Major"), "result must carry the severity badge");
  assert.ok(result.includes(EMERGENCY_LINE), "result must carry the emergency line");
  assert.ok(result.includes(DISCLAIMER_LINE), "result must carry the disclaimer");
  // session consumed by the query
  assert.equal(await getPending(601), undefined);
});

test("NONE tap cancels the session and prompts /check re-entry", async (t) => {
  if (!HAS_DB) t.skip("needs NEON_DATABASE_URL (photo_sessions table)");
  await _resetPhotoState();
  const { sent } = stubOutbound();
  // Bare Bot — the live callback handler would race the stub (double
  // registration via createBot) and hit the real Bot API.
  const bot = new Bot("ddicbot:local-placeholder", { botInfo: FALLBACK_BOT_INFO });
  const ddiDeps: DdiDeps = {
    ddi: async () => { throw new Error("must not be called"); },
    names: async () => ({}),
  };
  const photoDeps: PhotoDeps = {
    fetch: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg" }),
    vision: async () => [{ name: "Ibuprofen", lang: "en", confidence: 0.9 }],
    map: async () => [
      { ingredient_id: "ID_C", db_name: "ibuprofen", llm_name: "Ibuprofen", how: "exact", confidence: 0.9 },
    ],
    lang: () => "zh",
  };
  registerPhotoHandlers(bot, { photo: photoDeps, ddi: ddiDeps });
  await bot.handleUpdate(makePhotoUpdate("F3", 701));
  sent.length = 0;
  await bot.handleUpdate(makeCallbackUpdate("ddic:none", 701, 9));
  assert.ok(sent[0].text.includes("/check"), "none-tap must direct the user to /check");
  assert.equal(await getPending(701), undefined, "session cleared on none");
});

test("stale keyboard tap (no live session) is refused — no phantom confirm", async (t) => {
  if (!HAS_DB) t.skip("needs NEON_DATABASE_URL (photo_sessions table)");
  await _resetPhotoState();
  const ddiCalls: [string, string][] = [];
  const { sent } = stubOutbound();
  const bot = new Bot("ddicbot:local-placeholder", { botInfo: FALLBACK_BOT_INFO });
  const ddiDeps: DdiDeps = {
    ddi: async (a, b) => { ddiCalls.push([a, b]); return { found: false, pair_count: 0 }; },
    names: async () => ({}),
  };
  const photoDeps: PhotoDeps = {
    fetch: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg" }),
    vision: async () => [],
    map: async () => [],
    lang: () => "zh",
  };
  registerPhotoHandlers(bot, { photo: photoDeps, ddi: ddiDeps });
  await bot.handleUpdate(makeCallbackUpdate("ddic:pick:ID_Z", 801, 10));
  assert.equal(ddiCalls.length, 0);
  assert.ok(sent.length === 0, "no reply for a tap with no session (ack only)");
});

// ---------------------------------------------------------------------------
// A4. handlePhotoCore: no-drug / empty LLM output → 未识别到药品
// ---------------------------------------------------------------------------

test("handlePhotoCore: empty vision output → '未识别到药品 / No drug identified'", async (t) => {
  if (!HAS_DB) t.skip("needs NEON_DATABASE_URL (photo_sessions table)");
  await _resetPhotoState();
  const out = await handlePhotoCore(new Uint8Array([5]), "image/jpeg", 901, {
    fetch: async () => ({ bytes: new Uint8Array(), mime: "image/jpeg" }),
    vision: async () => [],
    map: async () => [],
    lang: () => "zh",
  });
  assert.equal(out.candidates.length, 0);
  assert.ok(out.text.includes("未识别到药品"), out.text);
  assert.ok(out.text.includes("No drug identified"), out.text);
  assert.ok(out.text.includes(EMERGENCY_LINE));
  assert.ok(out.text.includes(DISCLAIMER_LINE));
});

// ---------------------------------------------------------------------------
// B. DB-backed: runPhotoDdi against the real Neon branch (captured query)
// ---------------------------------------------------------------------------

// The live DDI pair verified in P1: warfarin + aspirin = Major.
// Registered only with the DB DSN — CI/airtight runs skip it cleanly.
if (HAS_DB)
  test("runPhotoDdi (live DB display names): warfarin+aspirin renders Major", async () => {
    // Real ids from the live branch (verified 2026-11-26 by the parent task).
    const ddiDeps: DdiDeps = {
      ddi: async () => ({ found: true, severity: "Major", mechanism_en: null, pair_count: 1 }),
      names: (await import("../lib/ddi-query.ts")).fetchDisplayNames,
    };
    const text = await runPhotoDdi(
      { id: "DDInter1951", label: "warfarin" },
      { id: "DDInter20", label: "aspirin" },
      951,
      ddiDeps,
      "zh",
    );
    assert.ok(text.includes("🔴 Major"), text);
    assert.ok(text.includes(EMERGENCY_LINE));
    assert.ok(text.includes(DISCLAIMER_LINE));
    assert.equal(await getPending(951), undefined);
  });
