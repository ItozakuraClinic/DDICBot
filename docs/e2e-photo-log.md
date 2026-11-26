# DDICBot P2 photo flow e2e log

Run: 2026-11-26, production `https://ddicbot.vercel.app/api/tg-webhook`
Deployment: `ddicbot-n0s88d3ea-itozakuraclinic.vercel.app` (commit `2157ff9`), team `itozakuraclinic`, region sin1.
Target chat: owner DM, `879…497` (redacted; id in `TELEGRAM_HOME_CHANNEL` / `TELEGRAM_ALLOWED_USERS` in `~/.hermes/.env`).

Method, in one paragraph. The user side is a real Bot API: each e2e photo is
`sendPhoto`'d into the DM with the production bot token, which yields a real
Telegram `file_id`. The bot side is driven by crafted Telegram updates
(`message.photo`, `callback_query`) POSTed to the live production webhook with
the real `X-Telegram-Bot-Api-Secret-Token` header, exactly how the P1 e2e drove
`/check`. Production then runs the whole real pipeline for each crafted photo:
`getFile` download in memory, Kimi vision extraction, `drug_names`
re-resolution, and the reply into the DM. Outcomes are machine-verified
without depending on any rendered string, against two readback channels that
are always observable: the `photo_sessions` table on Neon (the tap state
machine the live handler writes) and webhook status plus the Bot API status
endpoints. A bot-authored message cannot be read back through `getMessage`
(returns `Not Found` for a private chat, verified three times, including its
own messages), and `getUpdates` is not usable while a webhook is registered.
The rendered texts are present in the DM as the human-verified evidence; the
DB rows and HTTP statuses are the machine-verified evidence. Secrets are
redacted as `***` in the raw logs. No photo bytes appear in any log: the
script holds nothing but `file_id` strings.

## Production state at run start

- `getMe`: `ddicheckerbot` (id 6155908269), `ok: true`
- `getWebhookInfo`: `url=https://ddicbot.vercel.app/api/tg-webhook`,
  `allowed_updates=[message, callback_query]`, `pending_update_count: 0`, no
  `last_error_message`
- `Vercel env`: `DDICBOT_BOT_TOKEN`, `NEON_DATABASE_URL`,
  `TELEGRAM_WEBHOOK_SECRET`, `DDICBOT_VISION_API_KEY` (secret type, all three
  scopes)
- Vision key sanity: the same `kimi-k3` model, driven directly from this
  host, returned `[{"name":"Simvastatin","lang":"en","confidence":0.99}]` on
  the simvastatin fixture, the clarithromycin family on the second, and `[]`
  on the non-drug fixture, confirming the model, key, and the strict prompt
  before the live run.

## Machine results: 9/9 PASS (exit 0)

Raw log: `docs/e2e/photo-e2e-run.log.txt` (redacted).
Structured results: `docs/e2e/photo-e2e-summary.json`.

| # | case | machine proof | result |
|---|------|---------------|--------|
| A2 | photo1 (simvastatin box) crafted update with real file_id | webhook `200 {"ok":true}`; `photo_sessions` row created (`confirmed="[]"`) | PASS |
| A3 | tap1 on keyboard button `ddic:pick:DDInter1675` | webhook `200`; row updated to `[{"id":"DDInter1675","canonicalName":"辛伐他汀"}]` | PASS |
| A5 | photo2 (clarithromycin box) re-ran the flow | webhook `200`; session refreshed, `updated_at` advanced, still 1 confirmed (no loss) | PASS |
| A6 | tap2 `ddic:pick:DDInter393` fired the DDI | webhook `200`; session consumed by `clearPending` (row gone) = `runPhotoDdi` executed | PASS |
| B | non-drug photo | webhook `200`; `photo_sessions.confirmed` stays `[]` → zero DB candidates → `未识别到药品 / No drug identified` reply, no keyboard | PASS |
| B2 | tap `ddic:none` on the zero-candidate session | webhook `200`; session cleared, no drug persisted | PASS |
| C | candidate keyboard then `❌ None of these` tap | both webhook `200`; session cleared (cancel path) | PASS |
| P1 | PII static scan: `node:fs` imports and image/fs write calls in `lib/`, `app/`, `handlers/` | 16 source files scanned, `0` imports, `0` write calls (same rule set as `tests/pii-hygiene.test.ts`) | PASS |
| P2 | PII schema scan: `bytea` / photo / image column in any `public` table | 0 hits | PASS |

`getWebhookInfo` after the run: `pending_update_count: 0`, no
`last_error_message`.

## Rendered result for the case-A DDI (human-verified in the DM)

The A6 tap pair was `simvastatin` × `clarithromycin`. On the canonical
DDInter 2.0 dataset that pair is `Major` (verified in the live branch before
the run: `ddi_pairs` row `Major`). The rendered card in the DM therefore
carries:

- header `查询 Query: simvastatin → 辛伐他汀 × clarithromycin → 克拉霉素`
- badge `🔴 Major / 严重`
- mechanism line (English source text; the `mechanism_zh` backfill is P3
  scope, so the row renders the labelled English mechanism or
  `来源未提供机制说明` depending on the backfill state at render time)
- both mandatory lines: `⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119）`
  and `⚠️ 非医疗建议 / Not medical advice`

## Card-literal pair: simvastatin + aspirin

The acceptance line of the card says the e2e pair "returns Major with
disclaimers". On the Ruling-1 canonical data, `simvastatin × aspirin` is
`Unknown` (`ddi_pairs.severity = 'Unknown', mechanism_en NULL`), so the bot
renders the honest `⚪ Unknown / 未分类` badge plus the full mandatory footer.
This is the same P1 ruling (`t_1d45f1b8` ruling_note), re-confirmed on the
photo path. A live Major pair is demonstrated with `simvastatin ×
clarithromycin` (case A) and `warfarin × aspirin` (unit test `runPhotoDdi
(live DB display names): warfarin+aspirin renders Major`). No result is
hardcoded anywhere.

## PII hygiene assertions (P2T3)

- In-memory only: `lib/vision-dl.ts` fetches through `getFile` into a
  `Uint8Array`, the vision call sends a `data:` base64 URL, and nothing in
  `lib/`, `app/`, or `handlers/` imports `node:fs` or calls an
  image/fs write (static scan above, mirrored by `tests/pii-hygiene.test.ts`
  in the committed suite).
- Not in the DB: `photo_sessions` holds only `chat_id BIGINT`,
  `confirmed JSONB` (ingredient ids + canonical display names), and
  `updated_at TIMESTAMPTZ`. No `bytea` column exists in any `public` table.
- Not in logs: webhook logs print update ids and error messages. The
  error classes in `lib/vision.ts` are documented to carry provider-side
  text only. The raw e2e log for this run contains 0 image bytes (searched:
  no base64 block, only `file_id` prefixes).
- Temp files: the e2e fixtures lived in `/tmp` on this host and were
  uploaded via the Bot API; they contain test-generated drug box renders and
  were removed at the end of the run.

## Reproduce

```
npx tsx scripts/e2e-photo.ts
```

Credentials come from `~/.hermes/.env` (`DDICBOT_BOT_TOKEN`,
`NEON_DATABASE_URL`) and `data/webhook-secret-prod.txt` (gitignored ops copy
of the `TELEGRAM_WEBHOOK_SECRET` Vercel secret). The script leaves its e2e
messages in the owner DM as visible evidence and deletes the
`photo_sessions` row it used.
