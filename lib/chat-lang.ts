/**
 * Per-chat UI language (P3) — DB-backed.
 *
 * The choice made with `/lang en|zh|ja` lives in the chat_langs table so it
 * survives Vercel's stateless function instances and bot restarts (the same
 * reason photo_sessions exists: a /check update and its follow-up can land on
 * different instances). Chat id + a 2-char code only — no PII.
 *
 * Schema (idempotent CREATE in db/schema.sql + db/migrate.ts):
 *   chat_langs(chat_id BIGINT PRIMARY KEY,
 *              lang TEXT CHECK (lang IN ('en','zh','ja')),
 *              updated_at TIMESTAMPTZ DEFAULT now())
 *
 * Read contract: a missing row (new chat) resolves to the default "zh" —
 * the task-pinned default language. A DB read failure is degraded the same
 * way (zh), so a transient Neon blip can never break the /check reply; the
 * language is cosmetic, the mandatory footer is rendered either way.
 */
import { getPool } from "./db";

export type ChatLang = "en" | "zh" | "ja";

/** Default UI language for chats without a stored preference (task contract). */
export const CHAT_LANG_DEFAULT: ChatLang = "zh";

export const CHAT_LANGS: ChatLang[] = ["en", "zh", "ja"];

/**
 * Read the persisted UI language for a chat.
 * Returns CHAT_LANG_DEFAULT when the chat has no row or the read fails.
 */
export async function getChatLang(chatId: number): Promise<ChatLang> {
  try {
    const client = await getPool().connect();
    try {
      const r = await client.query("SELECT lang FROM chat_langs WHERE chat_id = $1", [chatId]);
      if (r.rowCount === 0) return CHAT_LANG_DEFAULT;
      const lang = r.rows[0].lang as ChatLang;
      return (CHAT_LANGS as string[]).includes(lang) ? lang : CHAT_LANG_DEFAULT;
    } finally {
      client.release();
    }
  } catch (err) {
    // Degrade to the default, never fail the reply path (see header).
    console.error("chat_langs read failed:", err instanceof Error ? err.message : err);
    return CHAT_LANG_DEFAULT;
  }
}

/**
 * Persist the UI language for a chat (upsert). Returns the stored value.
 * Validated against CHAT_LANGS; callers parse user input first, but the
 * CHECK constraint is the final backstop.
 */
export async function setChatLang(chatId: number, lang: ChatLang): Promise<ChatLang> {
  const client = await getPool().connect();
  try {
    await client.query(
      `INSERT INTO chat_langs (chat_id, lang, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (chat_id) DO UPDATE SET lang = EXCLUDED.lang, updated_at = now()`,
      [chatId, lang],
    );
    return lang;
  } finally {
    client.release();
  }
}
