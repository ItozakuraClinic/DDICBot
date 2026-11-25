# Phase 1 E2E log — production webhook

Date: 2026-11-26 (UTC+8)
Production URL: `https://ddicbot.vercel.app/api/tg-webhook`
Current prod build: `ddicbot-6iix0kp8c-itozakuraclinic.vercel.app` (an earlier build shipped with an empty output because the project had no framework set; the project was then patched to `nextjs` and redeployed). Aliases: `ddicbot.vercel.app` (prod), `ddicbot-itozakuraclinic.vercel.app` (team).
Bot: `@ddicheckerbot`
Target chat for reply delivery: bot owner's private chat (id redacted here, first3=879, last3=497)

## Method

Updates were crafted in-process (a Node script built each Telegram `update` object, set the `bot_command` entity exactly the way the Bot API emits it) and POSTed to the production webhook with the real `X-Telegram-Bot-Api-Secret-Token`. The bot processed each update through the real production code path and replied to the target chat. This is a true end-to-end run: Bot API in -> Vercel edge -> Next.js route -> pg query against Neon -> grammY handler -> Bot API out.

The four acceptance inputs were also run through `scripts/simulate-check.ts` (real bot + real DB, stubbed only the outbound reply) to capture the full reply text; both routes assert the same contract.

## Webhook registration (acceptance 1)

`setWebhook` -> `{"ok":true,"result":true,"description":"Webhook was set"}`

`getWebhookInfo` (after all E2E traffic):

```json
{
  "ok": true,
  "result": {
    "url": "https://ddicbot.vercel.app/api/tg-webhook",
    "has_custom_certificate": false,
    "pending_update_count": 0,
    "max_connections": 40,
    "ip_address": "64.29.17.131",
    "allowed_updates": ["message", "callback_query"]
  }
}
```

No `last_error_message` present. HTTP 200. Pass.

## Case results (acceptance 2, 3, 4)

| # | Input | Webhook HTTP | Reply (real path, via Neon) | Verdict |
|---|-------|--------------|------------------------------|---------|
| 1 | `/check simvastatin aspirin` | 200 `{"ok":true}` | ⚪ Unknown / 未分类 badge; `来源未提供机制说明`; `⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119）`; `⚠️ 非医疗建议 / Not medical advice` | Pass (data-corrected, see note) |
| 2 | `/check warfarin aspirin` | 200 `{"ok":true}` | 🔴 Major / 严重 badge + both mandatory lines | Pass |
| 3 | `/check zzzzqqqq aaaa` | 200 `{"ok":true}` | `数据库未收录该组合，不代表无相互作用。` + `The combination is not in the database...` + both mandatory lines; no "no interaction"/"safe" wording | Pass |
| 4 | `/start` | 200 `{"ok":true}` | Welcome with `/check` usage, `/lang`, `/help` hint + both mandatory lines | Pass |

Negative probes against the live endpoint:

| Probe | Expected | Got |
|-------|----------|-----|
| POST without secret token | 405 | 405 `{"ok":false,"error":"unauthorized"}` |
| POST with wrong token | 405 | 405 `{"ok":false,"error":"unauthorized"}` |
| GET (health probe) | 200 | 200 `{"status":"ok"}` |

## Data note (acceptance deviation, inherited from P1T6/T7)

The card's literal line "simvastatin aspirin returns Major with mechanism text" is not satisfiable on the Ruling-1 canonical data: in DDInter 2.0 that pair is `Unknown`, and `mechanism_en` is NULL on all 236,834 rows until the Phase-3 UI-crawl decision. The bot renders the honest `⚪ Unknown` badge plus the "no mechanism text on record" line plus the full mandatory footer for that pair. The Major badge path is demonstrated with the verified `warfarin + aspirin` pair in case 2. Full escalation four-piece lives on the completion metadata of this task and of t_a0f42c8f; the scope ruling belongs to the user. No results were hardcoded.

## Evidence files

- Raw (redacted) webhook + Bot API responses: `docs/e2e/e2e-production-raw.json`
- Full reply texts (simulate-check, real bot + real DB): `docs/e2e/simulate-check-latest.log`

## Secret hygiene

No token, DSN, or webhook-secret value appears in this log, in the evidence files (redacted to tokens like `BOT_TOKEN_REDACTED`), or in any committed file. The production webhook secret lives only in the Vercel environment (secret-typed) and in gitignored `data/webhook-secret-prod.txt` (chmod 600, local ops copy).
