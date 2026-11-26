import type { Bot } from "grammy";
import { queryDdi, fetchDisplayNames } from "../lib/ddi-query";
import {
  parseDrugTokens,
  resolveDrugName,
  type Lang,
  type NameResolution,
} from "../lib/name-resolve";
import { getChatLang, setChatLang } from "../lib/chat-lang";
import {
  renderCheck,
  parseLangInput,
  DEFAULT_LANG,
  DISCLAIMER_LINE,
  EMERGENCY_LINE,
  type CheckRender,
  type ResolvedSlot,
} from "../lib/render";

/**
 * /check handler (P1T7, P3 lang-persistence): parse drug names → resolve
 * both → query DDI → render result with the mandatory safety footer.
 *
 * The chat UI language is now DB-backed (lib/chat-lang.ts, chat_langs table)
 * instead of the in-memory Map P2 used: webhook instances are stateless, so
 * a `/lang ja` picked on instance A must still apply when the follow-up
 * /check lands on instance B. getChatLang is async (DB read, zh default on
 * a missing row or read failure); /lang en|zh|ja persists via setChatLang.
 *
 * Pure logic is split out into handleCheckCore so tests can drive it with
 * stub resolvers/queries and no grammY runtime; registerCheckHandlers wires
 * it into the Bot.
 */

export interface CoreDeps {
  resolve: (raw: string, hint: Lang) => Promise<NameResolution>;
  ddi: (idA: string, idB: string) => ReturnType<typeof queryDdi>;
  names: (ids: string[]) => ReturnType<typeof fetchDisplayNames>;
  /** Chat display-language resolver. DB-backed (lib/chat-lang getChatLang);
   *  async because the choice is persisted, so callers await it. */
  lang: (chatId: number) => Promise<Lang>;
}

/** Default deps wired to the live DB modules. */
export const liveDeps: CoreDeps = {
  resolve: resolveDrugName,
  ddi: queryDdi,
  names: fetchDisplayNames,
  lang: getChatLang,
};

/**
 * Core /check pipeline. Returns the rendered message; never throws for
 * query-level problems (rendered as a generic failure with the footer).
 */
export async function handleCheckCore(
  arg: string,
  chatId: number,
  deps: CoreDeps = liveDeps,
): Promise<CheckRender> {
  const tokens = parseDrugTokens(arg);
  if (tokens.length < 2) {
    const r: CheckRender = {
      text:
        "用法 Usage: /check <drug1> <drug2>\n" +
        "Example: /check simvastatin aspirin\n" +
        "(两种药品用空格或逗号分隔)\n\n" +
        [EMERGENCY_LINE, DISCLAIMER_LINE].join("\n"),
      found: false,
      bothResolved: false,
    };
    return r;
  }

  const lang = await deps.lang(chatId);
  const [rawA, rawB] = [tokens[0], tokens[1]];
  const [resA, resB] = await Promise.all([
    deps.resolve(rawA, lang),
    deps.resolve(rawB, lang),
  ]);
  const slots: ResolvedSlot[] = [
    { raw: rawA, resolution: resA },
    { raw: rawB, resolution: resB },
  ];

  if (!resA.ingredient_id || !resB.ingredient_id) {
    return renderCheck(slots[0], slots[1], { found: false, pair_count: 0 }, lang, {});
  }

  const ddi = await deps.ddi(resA.ingredient_id, resB.ingredient_id);
  const names = await deps.names([resA.ingredient_id, resB.ingredient_id]);
  return renderCheck(slots[0], slots[1], ddi, lang, names);
}

/**
 * Registers /check, /lang and /help on the bot.
 *
 * /lang (P3): `/lang en|zh|ja` persists the choice in chat_langs (DB) and
 * confirms; `/lang` with no argument reports the stored current language
 * (zh default when none is stored yet).
 *
 * /start stays in lib/bot.ts (WELCOME_MESSAGE contract, P1T1).
 */
export function registerCheckHandlers(bot: Bot, deps: CoreDeps = liveDeps): void {
  bot.command("check", (ctx) =>
    (async () => {
      try {
        const rendered = await handleCheckCore(ctx.match, ctx.chat.id, deps);
        await ctx.reply(rendered.text);
      } catch (err) {
        console.error("/check failed:", err);
        await ctx.reply(
          "❌ 查询失败，请稍后重试 / Query failed, please try again.\n" +
            [EMERGENCY_LINE, DISCLAIMER_LINE].join("\n"),
        );
      }
    })(),
  );

  bot.command("lang", (ctx) =>
    (async () => {
      const input = (ctx.match || "").trim();
      const footer = [EMERGENCY_LINE, DISCLAIMER_LINE].join("\n");
      if (!input) {
        const current = await getChatLang(ctx.chat.id);
        await ctx.reply(
          `当前语言 Current: ${current}\n` +
            "用法 Usage: /lang en | /lang zh | /lang ja\n\n" +
            footer,
        );
        return;
      }
      const parsed = parseLangInput(input);
      if (!parsed) {
        await ctx.reply("无效语言 Invalid value. Use: /lang en | /lang zh | /lang ja\n\n" + footer);
        return;
      }
      await setChatLang(ctx.chat.id, parsed);
      await ctx.reply(`语言已切换 Language set to: ${parsed}\n\n` + footer);
    })(),
  );

  const helpText =
    "DDICBot commands\n" +
    "/check <drug1> <drug2> — 查询药物相互作用 (space or comma separated)\n" +
    "/lang en | zh | ja — 设置回复语言 / set reply language\n" +
    "/help — 本帮助 / this help\n" +
    "/start — 欢迎信息 / welcome\n\n" +
    [EMERGENCY_LINE, DISCLAIMER_LINE].join("\n");
  bot.command("help", (ctx) => ctx.reply(helpText));
  // /start is registered in lib/bot.ts (WELCOME_MESSAGE, P1T1 contract).
}

export { DEFAULT_LANG, DISCLAIMER_LINE, EMERGENCY_LINE };
