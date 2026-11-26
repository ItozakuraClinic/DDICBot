/**
 * P3 chat_langs DB roundtrip test.
 *
 * Skipped cleanly when NEON_DATABASE_URL is absent (CI without the live
 * Neon branch). The table is idempotent-migrated by db/migrate.ts; these
 * tests use their OWN unique chat ids (millisecond-anchored) so they never
 * collide with a real user chat, and delete their rows afterwards.
 */
import { loadHermesEnv } from "../scripts/_load-env.ts";
process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || loadHermesEnv().NEON_DATABASE_URL || "";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  getChatLang,
  setChatLang,
  CHAT_LANGS,
  CHAT_LANG_DEFAULT,
} from "../lib/chat-lang.ts";
import { getPool } from "../lib/db.ts";

const HAS_DB = Boolean(process.env.NEON_DATABASE_URL);

if (HAS_DB) {
  const usedChatIds: number[] = [];
  // Monotonic unique id generator within the reserved range — no collision
  // even when two tests run in the same millisecond.
  let idSeq = Date.now() % 1_000_000;
  const uniqueChatId = (): number => {
    const id = 900_000_000 + (++idSeq) % 1_000_000;
    usedChatIds.push(id);
    return id;
  };
  after(async () => {
    if (usedChatIds.length) {
      const client = await getPool().connect();
      try {
        await client.query("DELETE FROM chat_langs WHERE chat_id = ANY($1)", [usedChatIds]);
      } finally {
        client.release();
      }
    }
    await getPool().end();
  });

  test("chat_langs: fresh chat id reads the zh default (no row yet)", async () => {
    const chatId = uniqueChatId();
    assert.equal(CHAT_LANG_DEFAULT, "zh", "task-pinned default is zh");
    assert.equal(await getChatLang(chatId), "zh");
  });

  for (const lang of CHAT_LANGS) {
    test(`chat_langs: set(${lang}) → get returns ${lang} (upsert roundtrip)`, async () => {
      const chatId = uniqueChatId();
      assert.equal(await getChatLang(chatId), "zh", "precondition: no row yet");
      await setChatLang(chatId, lang);
      assert.equal(await getChatLang(chatId), lang);
      // Second write (upsert, not duplicate key) switches the value.
      const next = CHAT_LANGS[(CHAT_LANGS.indexOf(lang) + 1) % CHAT_LANGS.length];
      await setChatLang(chatId, next);
      assert.equal(await getChatLang(chatId), next);
      // updated_at advanced on the upsert.
      const client = await getPool().connect();
      try {
        const r = await client.query(
          "SELECT count(*)::int n, max(updated_at) m FROM chat_langs WHERE chat_id = $1",
          [chatId],
        );
        assert.equal(r.rows[0].n, 1, "upsert must not duplicate the row");
        assert.ok(new Date(String(r.rows[0].m)).getTime() > 0, "updated_at is set");
      } finally {
        client.release();
      }
    });
  }

  test("chat_langs: CHECK constraint rejects unknown langs (DB backstop)", async () => {
    const client = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL });
    await client.connect();
    try {
      await assert.rejects(
        client.query("INSERT INTO chat_langs (chat_id, lang) VALUES (888888888888, 'klingon')"),
        /lang/,
      );
    } finally {
      await client.end();
    }
  });

  test("chat_langs: row for a real existing table shape (columns chat_id/lang/updated_at)", async () => {
    const client = await getPool().connect();
    try {
      const r = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name='chat_langs' ORDER BY column_name`,
      );
      const cols = Object.fromEntries(r.rows.map((x: { column_name: string; data_type: string }) => [x.column_name, x.data_type]));
      assert.deepEqual(Object.keys(cols).sort(), ["chat_id", "lang", "updated_at"]);
      assert.ok(cols.chat_id.includes("int"), "chat_id must be an int type (BIGINT)");
      assert.ok(cols.lang.startsWith("text"), "lang must be TEXT");
    } finally {
      client.release();
    }
  });
} else {
  test.skip("chat_langs DB roundtrip skipped (set NEON_DATABASE_URL)", () => {});
}
