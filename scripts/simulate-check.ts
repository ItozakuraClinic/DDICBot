/**
 * Simulated /check acceptance run (P1T7).
 *
 * Drives a REAL grammY Bot (same instance the webhook route creates) through
 * bot.handleUpdate() with synthetic Telegram update JSON — the exact path
 * app/api/tg-webhook/route.ts takes after X-Telegram-Bot-Api-Secret-Token
 * auth passes. Only the outbound Bot API call (ctx.reply → sendMessage) is
 * stubbed to capture reply text, because this host has no Telegram egress
 * guarantee; everything else (parsing, name resolution, DDI SQL, rendering)
 * runs for real against the live Neon branch DB.
 *
 * Usage: npx tsx scripts/simulate-check.ts   (needs NEON_DATABASE_URL via
 * scripts/_load-env.ts: process env > repo .env > ~/.hermes/.env)
 */
import { loadHermesEnv } from "./_load-env.ts";
process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || loadHermesEnv().NEON_DATABASE_URL || "";

import { createBot, FALLBACK_BOT_INFO } from "../lib/bot.ts";
import type { Bot } from "grammy";

let updateId = 100;
/**
 * Build a faithful Telegram message update. grammY's command filter reads
 * the real `entities` array (a bot_command entity at offset 0 whose length
 * spans only the command word), so we emit it exactly as the Bot API does.
 */
function makeMessage(text: string): any {
  const msg: any = {
    message_id: updateId,
    from: { id: 42, is_bot: false, first_name: "Sim", username: "sim_test" },
    chat: { id: 42, type: "private", first_name: "Sim" },
    date: Math.floor(Date.now() / 1000),
    text,
  };
  const m = text.match(/^\/([a-zA-Z0-9_]+)/);
  if (m) {
    msg.entities = [{ type: "bot_command", offset: 0, length: m[0].length }];
  }
  return { update_id: updateId++, message: msg };
}

const sent: string[] = [];
let nextId = 1;

interface Case {
  name: string;
  text: string;
  mustInclude: string[];
  mustNotInclude: string[];
}

const CASES: Case[] = [
  {
    name: "acceptance: /check simvastatin aspirin (live data = ⚪ Unknown pair; badge + footer render)",
    text: "/check simvastatin aspirin",
    mustInclude: ["⚪ Unknown", "120", "911", "119", "非医疗建议", "Not medical advice"],
    mustNotInclude: ["no interaction", "No interaction"],
  },
  {
    name: "Major badge path: /check warfarin aspirin (verified Major in the parent task)",
    text: "/check warfarin aspirin",
    mustInclude: ["🔴 Major", "120", "911", "119", "非医疗建议", "Not medical advice"],
    mustNotInclude: [],
  },
  {
    name: "zh input: /check 阿司匹林,辛伐他汀 (comma separated, Chinese surface names)",
    text: "/check 阿司匹林,辛伐他汀",
    mustInclude: ["120", "911", "119", "非医疗建议", "Not medical advice"],
    mustNotInclude: ["no interaction"],
  },
  {
    name: "acceptance: /check zzzzqqqq aaaa → 未收录 (NOT 'no interaction')",
    text: "/check zzzzqqqq aaaa",
    mustInclude: ["数据库未收录该组合，不代表无相互作用。", "120", "911", "119", "非医疗建议", "Not medical advice"],
    mustNotInclude: ["no interaction", "No interaction"],
  },
  {
    name: "unresolvable single name: /check zzzzqqqq aspirin → re-prompt + 未收录 line",
    text: "/check zzzzqqqq aspirin",
    mustInclude: ["无法识别", "zzzzqqqq", "120", "非医疗建议", "Not medical advice"],
    mustNotInclude: ["no interaction"],
  },
  {
    name: "usage: /check with one token → usage line + footer",
    text: "/check aspirin",
    mustInclude: ["/check <drug1> <drug2>", "120", "非医疗建议", "Not medical advice"],
    mustNotInclude: [],
  },
  {
    name: "/lang en switches reply language",
    text: "/lang en",
    mustInclude: ["Language set to: en"],
    mustNotInclude: [],
  },
  {
    name: "/check (en lang) simvastatin aspirin → English-first chrome, footer intact",
    text: "/check simvastatin aspirin",
    mustInclude: ["Query:", "120", "911", "119", "非医疗建议", "Not medical advice"],
    mustNotInclude: ["no interaction"],
  },
  {
    name: "/help lists commands",
    text: "/help",
    mustInclude: ["/check", "/lang", "/start"],
    mustNotInclude: [],
  },
  {
    name: "/start welcome carries usage + footer",
    text: "/start",
    mustInclude: ["/check", "/help", "120", "119", "非医疗建议", "Not medical advice"],
    mustNotInclude: [],
  },
];

async function runCases(bot: Bot): Promise<number> {
  let failed = 0;
  for (const c of CASES) {
    sent.length = 0;
    await bot.handleUpdate(makeMessage(c.text) as never);
    const reply = sent[0] ?? "";
    const missing = c.mustInclude.filter((s) => !reply.includes(s));
    const present = c.mustNotInclude.filter((s) => reply.toLowerCase().includes(s.toLowerCase()));
    const ok = missing.length === 0 && present.length === 0;
    if (!ok) failed++;
    console.log(`\n=== ${c.name} === [${ok ? "PASS" : "FAIL"}]`);
    if (missing.length) console.log("  MISSING:", JSON.stringify(missing));
    if (present.length) console.log("  FORBIDDEN PRESENT:", JSON.stringify(present));
    console.log("  --- reply ---");
    console.log(reply.split("\n").map((l) => "  " + l).join("\n"));
  }
  return failed;
}

async function main() {
  if (!process.env.NEON_DATABASE_URL) {
    console.error("NEON_DATABASE_URL not resolved — refusing to run (tests need the live DB)");
    process.exit(1);
  }
  const bot = createBot("ddicbot:local-placeholder", FALLBACK_BOT_INFO);

  // Stub ONLY the outbound Bot API. ctx.reply → ctx.api.sendMessage, resolved
  // via Api.prototype (grammY builds a fresh Api instance per update, so the
  // prototype is the single choke point). Patch it to capture reply text
  // instead of hitting the network; restore afterwards. Inbound handleUpdate,
  // command matching, and the handler pipeline are completely untouched.
  const { Api } = await import("grammy");
  type Proto = { sendMessage: Function };
  const proto = Api.prototype as unknown as Proto;
  const origSendMessage = proto.sendMessage;
  proto.sendMessage = function (
    this: unknown,
    chatId: number,
    text: string,
    other?: unknown,
    signal?: unknown,
  ) {
    sent.push(typeof text === "string" ? text : String(text));
    return Promise.resolve({
      message_id: nextId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId ?? 42, type: "private" },
      text,
    });
  };

  let failed = 0;
  try {
    failed = await runCases(bot);
  } finally {
    (Api.prototype as unknown as Proto).sendMessage = origSendMessage;
    (await import("../lib/db.ts")).getPool().end();
  }
  console.log(`\n================= ${CASES.length - failed}/${CASES.length} cases pass =================`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
