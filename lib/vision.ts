import { loadEnv } from "./env";

/**
 * Vision LLM client: photo bytes → structured drug-name candidates (P2T1).
 *
 * THE LLM IS ONLY A CANDIDATE-EXPANSION LAYER. It may hallucinate, miss,
 * or fabricate names — every candidate it returns is re-validated against
 * the drug_names database by the caller (exact + pg_trgm via
 * name-resolve). The DB is the source of truth; a name the DB does not
 * recognize is dropped before the user ever sees it.
 *
 * PROVIDER CONTRACT
 * -----------------
 *   base URL : https://api.moonshot.cn/v1  (Kimi China endpoint — the
 *               user's Moonshot key is api.moonshot.cn-only; .ai 401s)
 *   model    : DDICBOT_VISION_MODEL, default "kimi-k3" (vision-verified
 *               2026-11-26 on this key; k3.1-pro / k2.6 also accept
 *               image_url)
 *   key env  : DDICBOT_VISION_API_KEY (Vercel secret; NOT to be confused
 *               with DDICBOT_BOT_TOKEN)
 *   transport: chat/completions, image as a data: base64 URL — Telegram's
 *               file bytes never leave process memory.
 *
 * PII-HYGIENE INVARIANT (safety rule 4 — asserted in
 * tests/pii-hygiene.test.ts): this module never touches node:fs, never
 * writes the buffer anywhere, and nothing in the error paths below embeds
 * the buffer or its base64 into a message. If you add logging here, log
 * sizes and mime types only.
 */

export const VISION_BASE_URL = "https://api.moonshot.cn/v1";
export const VISION_DEFAULT_MODEL = "kimi-k3";
/** Hard cap on photo bytes accepted from Telegram (task-pinned 4 MB). */
export const VISION_MAX_BYTES = 4 * 1024 * 1024;
/** Max candidates the LLM may return (task-pinned 5). */
export const VISION_MAX_CANDIDATES = 5;

/** Strict system prompt — pinned wording from the P2T1 contract. */
export const VISION_SYSTEM_PROMPT =
  "Extract drug names visible in this image. Return JSON: [{name, lang, confidence}]. Max 5 candidates. If no drug visible, return []." +
  " Reply with ONLY the JSON array — no prose, no markdown, no code fences.";

export interface VisionCandidate {
  /** Surface name as the model read it (unvalidated). */
  name: string;
  /** Script hint reported by the model; may be wrong. */
  lang: "en" | "zh" | "ja" | "other";
  /** Model self-reported confidence in [0, 1]. */
  confidence: number;
}

/** Minimal OpenAI-compatible error surface (keeps this free of SDK deps). */
interface ChatCompletionChoice {
  message?: { content?: string | null };
  finish_reason?: string | null;
}

async function callVisionLlm(imageB64: string, mime: string, timeoutMs: number): Promise<string> {
  const key = loadEnv().visionApiKey;
  if (!key) {
    // 503 contract: the route translates this into a 503 with a clear message.
    throw new VisionNotConfiguredError("vision LLM key is not configured on this deployment");
  }
  const model = loadEnv().visionModel || VISION_DEFAULT_MODEL;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${VISION_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: VISION_SYSTEM_PROMPT },
              {
                type: "image_url",
                image_url: { url: `data:${mime};base64,${imageB64}` },
              },
            ],
          },
        ],
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string }; choices?: ChatCompletionChoice[] }
      | null;
    if (!res.ok || !body) {
      // The error body is provider-side text; it never contains our image.
      throw new VisionUpstreamError(`vision upstream ${res.status}: ${body?.error?.message ?? "no body"}`);
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new VisionParseError("vision model returned an empty completion");
    }
    return content;
  } catch (err) {
    if (err instanceof VisionError) throw err;
    if ((err as { name?: string })?.name === "AbortError") {
      throw new VisionUpstreamError(`vision request timed out after ${timeoutMs}ms`);
    }
    // Network-level failure. The base message is ours and carries no photo
    // bytes or base64 — safe for the route to surface.
    throw new VisionUpstreamError(`vision request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract candidate drug names from in-memory photo bytes.
 *
 * @param image  Photo bytes, held in memory ONLY for the call duration.
 *               The caller must not retain it after this resolves.
 * @param mime   MIME type as reported by Telegram (image/jpeg, image/png...).
 */
export async function extractCandidates(
  image: Uint8Array,
  mime: string,
  timeoutMs = 30_000,
): Promise<VisionCandidate[]> {
  if (image.byteLength === 0) {
    throw new VisionParseError("empty image");
  }
  if (image.byteLength > VISION_MAX_BYTES) {
    throw new VisionParseError(
      `image too large: ${image.byteLength} bytes > ${VISION_MAX_BYTES} cap`,
    );
  }
  const raw = await callVisionLlm(Buffer.from(image).toString("base64"), mime, timeoutMs);
  return parseModelOutput(raw);
}

// ---------------------------------------------------------------------------
// Output parsing (pure — unit-testable without the network)
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function normalizeLang(s: unknown): VisionCandidate["lang"] {
  const t = typeof s === "string" ? s.trim().toLowerCase() : "";
  if (t === "en" || t === "english" || t === "english name") return "en";
  if (t === "zh" || t === "cn" || t === "chinese") return "zh";
  if (t === "ja" || t === "japanese") return "ja";
  return "other";
}

/**
 * Tolerant parser for the model output: strips markdown fences and leading
 * prose, finds the first balanced JSON array, and validates each element.
 * Returns [] on a genuinely empty list; throws VisionParseError when the
 * payload cannot be read as a candidates array.
 */
export function parseModelOutput(raw: string): VisionCandidate[] {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();

  // 1) Whole payload: if it IS valid JSON, it must be an array (the contract
  //    says "Reject non-array"). An object like {"candidates":[...]} would
  //    otherwise leak its inner [] through the fallback below — so a
  //    top-level non-array JSON value is a hard parse error.
  try {
    const whole = JSON.parse(s);
    if (!Array.isArray(whole)) throw new VisionParseError("model output JSON is not an array");
    return validateArray(whole);
  } catch (err) {
    if (err instanceof VisionParseError) throw err;
    // Not clean JSON on its own — 2) extract the outermost balanced array
    //    (models commonly wrap the array in one line of prose).
  }

  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new VisionParseError("model output contains no JSON array");
  }
  let slice: unknown;
  try {
    slice = JSON.parse(s.slice(start, end + 1));
  } catch {
    throw new VisionParseError("model output JSON is malformed");
  }
  if (!Array.isArray(slice)) throw new VisionParseError("model output JSON is not an array");
  return validateArray(slice);
}

function validateArray(arr: unknown[]): VisionCandidate[] {
  const out: VisionCandidate[] = [];
  for (const el of arr.slice(0, VISION_MAX_CANDIDATES)) {
    if (typeof el !== "object" || el === null) continue;
    const nameRaw = (el as { name?: unknown }).name;
    if (typeof nameRaw !== "string") continue; // non-string name → not usable
    const name = nameRaw.trim();
    if (name.length === 0 || name.length > 120) continue;
    out.push({
      name,
      lang: normalizeLang((el as { lang?: unknown }).lang),
      confidence: clamp01(Number((el as { confidence?: unknown }).confidence)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error taxonomy (route maps these to user-safe status codes)
// ---------------------------------------------------------------------------

export class VisionError extends Error {}
/** Key missing on the deployment → 503 "vision not configured". */
export class VisionNotConfiguredError extends VisionError {}
/** Upstream (Moonshot) HTTP/network failure → surfaced as a retry prompt. */
export class VisionUpstreamError extends VisionError {}
/** Bad/over-cap input or unreadable model output. */
export class VisionParseError extends VisionError {}
