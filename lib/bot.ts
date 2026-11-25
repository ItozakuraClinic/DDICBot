import { Bot } from "grammy";
import type { BotFullInfo } from "grammy/types";
import { loadEnv } from "./env";

export const WELCOME_MESSAGE =
  "DDICBot — drug–drug interaction checker · 药物相互作用查询工具\n" +
  "用法 Usage: /check <drug1> <drug2> (e.g. /check simvastatin aspirin)\n\n" +
  "🚨 紧急请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119）\n" +
  "⚕️ 数据库检索仅供信息参考，非医疗建议。 / Database lookup only — not medical advice.";

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
  return bot;
}
