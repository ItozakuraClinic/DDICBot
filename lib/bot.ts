import { Bot } from "grammy";
import type { BotFullInfo } from "grammy/types";
import { registerCheckHandlers } from "../handlers/check";
import { registerPhotoHandlers } from "../handlers/photo";
import { EMERGENCY_LINE, DISCLAIMER_LINE } from "./render";
import { loadEnv } from "./env";

/**
 * Reply text for /start. The safety footer is built from the same shared
 * constants as every other reply path (render.ts), so safety rule 1
 * (emergency line + ⚠️ 非医疗建议 / Not medical advice on EVERY reply) has
 * one source of truth — /start cannot drift from /check.
 */
export const WELCOME_MESSAGE =
  "DDICBot — drug–drug interaction checker · 药物相互作用查询工具\n" +
  "用法 Usage: /check <drug1> <drug2> (e.g. /check simvastatin aspirin)\n" +
  "语言: /lang en 或 /lang zh（默认中文）· 帮助 Help: /help\n\n" +
  EMERGENCY_LINE +
  "\n" +
  DISCLAIMER_LINE;

/**
 * Placeholder botInfo used when `bot.init()` (getMe) cannot complete, e.g. in
 * local or CI environments without a real token or network access to the
 * Telegram Bot API. It keeps the webhook endpoint able to validate headers and
 * answer instead of 500ing on the first update.
 */
export const FALLBACK_BOT_INFO: BotFullInfo = {
  id: 0,
  is_bot: true,
  first_name: "DDICBot",
  username: "ddicbot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_guest_queries: false,
  supports_inline_queries: false,
  needs_inline_query_location: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  has_topic_sidebar: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

/**
 * Builds the grammY Bot. Pass `botInfo` to skip the getMe() round-trip.
 * Handlers added here are intentionally minimal in P1 (skeleton phase):
 * /check lands on top of this in the query-core task.
 */
export function createBot(botToken?: string, botInfo?: BotFullInfo): Bot {
  const token = botToken ?? loadEnv().botToken;
  if (!token) {
    throw new Error("DDICBOT_BOT_TOKEN is not set");
  }
  const bot = new Bot(token, botInfo ? { botInfo } : undefined);
  // Global uncaught-error handler (P1T1 spec: bot.catch). In webhook mode this
  // catches errors that bubble out of handleUpdate/handlers beyond the
  // route's own try/catch (e.g. errors in async middleware).
  bot.catch((err) => {
    console.error("grammY bot.catch:", err.message);
  });
  bot.command("start", (ctx) => ctx.reply(WELCOME_MESSAGE));
  // /check, /lang, /help (P1T7): bilingual DDI checker with mandatory
  // safety footer on every reply.
  registerCheckHandlers(bot);
  // Photo flow (P2T2): onPhoto → vision candidates → DB-validated inline
  // keyboard → explicit-tap confirmation → the single DDI call site.
  // The onPhoto path carries NO ddi dependency (never-auto-match invariant);
  // see handlers/photo.ts.
  registerPhotoHandlers(bot);
  return bot;
}
