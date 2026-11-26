# DDICBot final-QA wording audit (P3T4)

Run on 2026-11-26 against the final-QA working tree (parent commit e4aae72 plus
the P3T4 changes that this gate covers). Scope: every string a Telegram user
can see. Machine checks (grep over `lib/`, `handlers/`, `app/` for runtime
code; `git ls-files` for committed artifacts) plus the qa-matrix reply asserts
(`scripts/qa-matrix.ts`), which re-check the forbidden phrases in every
rendered reply at runtime.

## 1. The two mandatory lines

Source of truth: `EMERGENCY_LINE` and `DISCLAIMER_LINE` in `lib/render.ts`.
Every reply path builds its footer from these two constants; there is no
hand-typed copy of the emergency numbers anywhere else.

| Reply path | Footer present | Evidence |
| --- | --- | --- |
| `/check` found (severity render) | yes | `renderCheck` found branch pushes `footer(lang)` |
| `/check` not found | yes | same function, not-found branch |
| `/check` unresolvable (re-prompt) | yes | same function, unresolved branch |
| `/check` usage (fewer than 2 tokens) | yes | `handlers/check.ts` usage text |
| `/check` error (thrown) | yes | `handlers/check.ts` catch path |
| `/start` | yes | `lib/bot.ts` `WELCOME_MESSAGE` |
| `/lang` (all three outcomes: set, current, invalid) | yes | `handlers/check.ts` (added by this QA: `/lang` and `/help` previously had no footer, which was a safety-rule-1 violation) |
| `/help` | yes | `handlers/check.ts` (added by this QA, same fix) |
| photo received / processing | yes | `handlers/photo.ts` `pmsg` |
| photo candidates keyboard | yes | `handlePhotoCore` |
| photo non-drug (未识别到药品) | yes | `handlePhotoCore` empty-candidates text |
| photo tap 1/2 confirmation | yes | callback handler `say(...)` |
| photo none-tap cancel | yes | callback handler |
| photo failure (all four error kinds) | yes | `reportPhotoFailure` |
| photo DDI result | yes | `runPhotoDdi` goes through `renderCheck` |

Both lines: `⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119）`
and `⚠️ 非医疗建议 / Not medical advice`.

Note: the `api/tg-webhook` HTTP 404/error JSON bodies are not user-facing
Telegram replies (Telegram only sees the crafted-update responses); the cron
route JSON is operator-facing. Neither is a chat message, so the footer rule
does not apply to HTTP error bodies.

## 2. Forbidden wording: "safe", "no interaction", "no problem"

Grep of all runtime source (`lib/`, `handlers/`, `app/`), 12 hits, every one
in a comment or a doc line, zero in a user-facing string literal:

| File | Line | Context |
| --- | --- | --- |
| `lib/photo-state.ts` | 63 | comment: `corrupt row → treat as empty session (safe: re-tap)` |
| `lib/vision-map.ts` | 17 | doc comment: `Showing them is safe: the confirmation keyboard...` |
| `lib/vision.ts` | 112 | comment: `bytes or base64 — safe for the route to surface` |
| `lib/vision.ts` | 217 | comment: `error taxonomy (route maps these to user-safe status codes)` |
| `lib/render.ts` | 76, 150 | doc comments restating the rule itself |
| `lib/ddi-query.ts` | 11-12 | doc comment: `NEVER "no interaction", "safe"...` |
| `lib/vision-dl.ts` | 49 | comment: `Bot API error text contains no image bytes; safe to surface` |
| `handlers/photo.ts` | 310 | doc comment: `User-safe failure messages` |
| `app/api/cron/refresh/route.ts` | 283 | comment: `Re-dispatching while a run is in flight is safe` (operator-facing route) |

Runtime confirmation: `scripts/qa-matrix.ts` asserts that none of the strings
`safe`, `no interaction`, `no problem` (case-insensitive) appears in any of
the 45 rendered `/check` replies, the not-found replies, or the command
replies, and the run came back clean.

Verdict: zero violations in user-facing strings.

## 3. Not-found wording (exact strings)

Pinned in `lib/render.ts` and asserted verbatim by the qa-matrix on every
not-found reply of each language:

| Language | Required string | In code | Byte-exact check |
| --- | --- | --- | --- |
| zh | `数据库未收录该组合，不代表无相互作用。` | `NOT_IN_DB_ZH` | ok |
| en | `This combination is not in our database` | `NOT_IN_DB_EN` (changed by this QA from the longer P1 sentence "not in the database. An absent record is not evidence of interaction-free use"; test expectations updated deliberately) | ok |
| ja | `この組み合わせはデータベースに収録されていません` | `NOT_IN_DB_JA` (added by this QA; ja had no display chrome before) | ok |

`notFoundBlock()` renders the current language's line first and keeps the
other two lines present, so all three strings are machine-assertable in every
language's reply regardless of order.

## 4. Photo data: logs, DB, temp files

- Static scan of `lib/`, `app/`, `handlers/`: zero `node:fs` imports, zero
  `writeFile`/`createWriteStream`/`appendFile` calls. Photo bytes only exist
  as an in-memory `Uint8Array` between download and the vision call, then are
  dropped. The same scan is in `tests/pii-hygiene.test.ts` (asserts it fails
  the build if an fs import reappears).
- DB schema: no `bytea` column, no `photo`/`image`-named column in any public
  table (checked via `information_schema`; also asserted in
  `tests/pii-hygiene.test.ts`). `photo_sessions` stores `chat_id` + JSON of
  `{id, canonicalName}` pairs (ingredient ids and DB display names only).
  `chat_langs` (new in this QA) stores `chat_id` + a 2-letter language code.
- Temp files: nothing under `data/` or `docs/` is committed that carries
  image bytes; `git ls-files '*.jpg|png|jpeg|webp'` returns nothing.
  `data/test-photo-e2e/` (4 packaging photos used as e2e fixtures) and
  `data/webhook-secret-prod.txt` are gitignored (`data/` is ignored except
  the two tracked evidence patterns; verified in `.gitignore`).
- Committed logs (`docs/e2e/*.log.txt`, `docs/e2e/*.json`, `docs/qa-matrix-log.md`,
  `docs/e2e/e2e-final-run.json`): no line exceeds 4000 chars (long-line scan),
  no base64 blocks; the e2e harnesses redact bot token, webhook secret, and
  DSN from their written logs before they touch disk.

Verdict: no photo data in any log, DB table, or committed/temp file.

## 5. Findings fixed by this QA pass

1. `/lang` and `/help` replies carried no mandatory footer (safety-rule-1
   gap introduced when the commands were reshaped in P1T7). Fixed: both now
   build the footer from the shared constants.
2. `NOT_IN_DB_EN` did not match the pinned wording. Replaced with the exact
   required string.
3. Japanese was resolution-input only (`/lang ja` silently displayed
   English). Full ja display added: badges (重大/中度/軽微/未分類), the pinned
   ja not-found line, ja mechanism line (`仕組み:` with labelled en fallback),
   ja unresolvable re-prompt, ja photo prompts.
4. `/lang` state was an in-memory `Map` in a stateless Vercel worker: a
   follow-up `/check` landing on a different instance lost the user's choice.
   Now persisted in `chat_langs` (DB), the `photo_sessions` pattern.

## 6. Methods used

- `grep -rn` over runtime dirs for the forbidden phrases and all
  `reply(`/`sendMessage(`/`editMessageText(` call sites (full list in
  section 1, all covered).
- Node one-liner byte-exact substring check of the three pinned not-found
  strings in `lib/render.ts`.
- `git ls-files` + long-line scan over committed docs for image leaks.
- `scripts/qa-matrix.ts` runtime asserts on 45+ rendered replies
  (see `docs/qa-matrix-log.md`).
