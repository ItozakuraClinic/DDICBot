/**
 * Photo confirmation state (P2T2) — DB-backed.
 *
 * Why the DB: Vercel serves webhook POSTs from stateless function instances.
 * A photo update and its follow-up tap can land on DIFFERENT instances, so
 * the "one drug confirmed, awaiting the second" state must survive across
 * invocations — hence photo_sessions (chat_id + JSON list of confirmed
 * ingredient_ids + timestamp). NOTHING image-related is stored here (PII
 * rule 4, asserted in tests/pii-hygiene.test.ts).
 *
 * TTL: sessions older than PHOTO_STATE_TTL_MS are treated as expired
 * (lazy delete on read/update). A bot restart or a long pause simply drops
 * the session; the user re-sends the photo. Nothing is auto-queried.
 *
 * NEVER-AUTO-MATCH CONTRACT (safety rule 3, non-negotiable):
 * Nothing in this module queries ddi_pairs. The single DDI call site is
 * handlers/photo.ts `runPhotoDdi`, reachable only from a callback_query
 * (button tap) once `confirm` has recorded TWO distinct ingredient_ids.
 */
import { getPool } from "./db";

/** A session older than this is treated as expired. */
export const PHOTO_STATE_TTL_MS = 5 * 60 * 1000;

export interface ConfirmedDrug {
  /** Canonical ingredient_id the user tapped. */
  id: string;
  /** Database surface name for display (from drug_names, not the LLM). */
  canonicalName: string;
}

export interface PendingPhotoState {
  confirmed: ConfirmedDrug[];
  updatedAt: number;
}

export interface ConfirmOutcome {
  ok: boolean;
  /** False when the chat had no live session to confirm into. */
  pending: boolean;
  /** Set when the chat already has this exact drug confirmed (duplicate tap). */
  duplicate?: boolean;
  /** True once TWO distinct drugs are confirmed — caller may (and must) run the DDI. */
  readyForDdi: boolean;
  confirmed: ConfirmedDrug[];
}

function parseRow(row: { confirmed: string; updated_at: Date | string }): PendingPhotoState {
  const updatedAt = row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime();
  let confirmed: ConfirmedDrug[] = [];
  try {
    const parsed: unknown = JSON.parse(row.confirmed);
    if (Array.isArray(parsed)) {
      confirmed = parsed
        .filter(
          (c): c is { id: string; canonicalName: string } =>
            !!c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string" &&
            typeof (c as { canonicalName?: unknown }).canonicalName === "string",
        )
        .map((c) => ({ id: c.id, canonicalName: c.canonicalName }));
    }
  } catch {
    confirmed = []; // corrupt row → treat as empty session (safe: re-tap)
  }
  return { confirmed, updatedAt };
}

/**
 * Read the live session for a chat. Expired or absent → undefined.
 * (Idempotent: a read never mutates state except deleting dead rows.)
 */
export async function getPending(chatId: number): Promise<PendingPhotoState | undefined> {
  const client = await getPool().connect();
  try {
    const res = await client.query(
      "SELECT confirmed, updated_at FROM photo_sessions WHERE chat_id = $1",
      [chatId],
    );
    if (res.rowCount === 0) return undefined;
    const st = parseRow(res.rows[0]);
    const age = Date.now() - st.updatedAt;
    if (age > PHOTO_STATE_TTL_MS) {
      await client.query("DELETE FROM photo_sessions WHERE chat_id = $1 AND updated_at < $2", [
        chatId,
        new Date(st.updatedAt),
      ]);
      return undefined; // expired
    }
    return st;
  } finally {
    client.release();
  }
}

/**
 * Start or refresh a session for a chat.
 *  - No session: create an empty one.
 *  - Live session: refresh its timestamp and PRESERVE the confirmed drug(s)
 *    (the two-photo flow: the drug confirmed from photo A is still valid
 *    while photo B's keyboard is on screen).
 *  - Expired session: replace it with a fresh empty one.
 */
export async function setPending(chatId: number): Promise<PendingPhotoState> {
  const current = await getPending(chatId);
  const confirmedJson = current ? JSON.stringify(current.confirmed) : "[]";
  const client = await getPool().connect();
  try {
    await client.query(
      `
      INSERT INTO photo_sessions (chat_id, confirmed, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (chat_id) DO UPDATE SET confirmed = EXCLUDED.confirmed, updated_at = now();
      `,
      [chatId, confirmedJson],
    );
    return (await getPending(chatId)) ?? { confirmed: [], updatedAt: Date.now() };
  } finally {
    client.release();
  }
}

export async function clearPending(chatId: number): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("DELETE FROM photo_sessions WHERE chat_id = $1", [chatId]);
  } finally {
    client.release();
  }
}

/**
 * Record an explicit user confirmation (a button tap). Reads the current
 * session, appends the tapped drug, writes it back, and reports whether the
 * pair is now complete. Duplicate taps are flagged and never double-counted.
 */
export async function confirm(
  chatId: number,
  id: string,
  canonicalName: string,
): Promise<ConfirmOutcome> {
  if (!id || !canonicalName) {
    return { ok: false, pending: false, readyForDdi: false, confirmed: [] };
  }
  const client = await getPool().connect();
  try {
    const res = await client.query(
      "SELECT confirmed, updated_at FROM photo_sessions WHERE chat_id = $1",
      [chatId],
    );
    if (res.rowCount === 0) {
      return { ok: false, pending: false, readyForDdi: false, confirmed: [] };
    }
    const st = parseRow(res.rows[0]);
    if (Date.now() - st.updatedAt > PHOTO_STATE_TTL_MS) {
      await client.query("DELETE FROM photo_sessions WHERE chat_id = $1", [chatId]);
      return { ok: false, pending: false, readyForDdi: false, confirmed: [] };
    }
    if (st.confirmed.some((c) => c.id === id)) {
      return { ok: true, pending: true, duplicate: true, readyForDdi: false, confirmed: st.confirmed };
    }
    st.confirmed.push({ id, canonicalName });
    const readyForDdi = st.confirmed.length >= 2;
    const toStore = st.confirmed.slice(0, 2); // storage cap: the DDI pair needs two
    await client.query(
      "UPDATE photo_sessions SET confirmed = $2, updated_at = now() WHERE chat_id = $1",
      [chatId, JSON.stringify(toStore)],
    );
    return { ok: true, pending: true, readyForDdi, confirmed: [...st.confirmed] };
  } finally {
    client.release();
  }
}

/**
 * Test/ops hook: clear all sessions (local DB tests only — never called
 * from the bot runtime).
 */
export async function _resetPhotoState(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("DELETE FROM photo_sessions");
  } finally {
    client.release();
  }
}
