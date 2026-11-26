# DDICBot

Telegram bot for drug–drug interaction (DDI) lookup, built for 公益/应急现场
judgment. Bilingual: Chinese, English, Japanese. Type two drug names (or send
two packaging photos) and it answers with the DDInter 2.0 severity for the
pair, plus a mechanism line when the source has one. The bot is deliberately
honest about its limits: when the pair is not in the database it says exactly
that, and every reply carries the emergency numbers and a not-medical-advice
line.

Stack: Next.js (App Router) + TypeScript + [grammY](https://grammy.dev/)
webhook on Vercel (Node runtime only), [Neon](https://neon.tech) Postgres
(`pg_trgm` fuzzy matching), DDInter 2.0 as the interaction source.

## Safety disclaimers (read this first)

- DDICBot is a database lookup tool, not a clinician. Every reply ends with
  the emergency line (中国大陆 120 / 美国 911 / 日本 119) and
  `⚠️ 非医疗建议 / Not medical advice`.
- `数据库未收录该组合` / `This combination is not in our database` /
  `この組み合わせはデータベースに収録されていません` means the pair has no
  row in DDInter 2.0. It does not mean the combination is interaction-free.
  The bot is required by its safety rules to never render "no interaction",
  "safe", or any wording that implies a miss is good news.
- Photos are only ever processed in memory: downloaded from the Bot API,
  sent to the vision model, and dropped. No image bytes are written to disk,
  to the database, or to any log. Candidate names still require an explicit
  button tap before a query runs; the bot never auto-matches a photo to a
  drug.
- Severity labels and mechanism text come from DDInter 2.0 as published on
  2026-11-25 plus the daily refresh described below. If the source is wrong,
  the bot inherits the error. Check with a pharmacist before acting on any
  result, especially at a 急救 scene.
- The project is non-commercial self-use only (see Data sources and
  license notes).

## Bot commands

| Command | Behavior |
| --- | --- |
| `/check <drug1> <drug2>` | Space or comma separated, zh/en/ja input all resolve. Resolves each name (exact, then `pg_trgm` fuzzy at threshold 0.3; ambiguous shared names surface candidates instead of guessing) and renders the DDI row: severity badge, mechanism line in the reply language, resolved pair. |
| `/lang en \| zh \| ja` | Sets the reply language for the chat. Persisted in the database, so the choice survives across Vercel function instances and bot restarts. Default: zh. |
| `/help`, `/start` | Command list; welcome + usage. |
| *(send a photo)* | Vision model proposes candidate drugs, shown as an inline keyboard with confidence and a `❌ None of these / 都不是` row. Tap the drugs you are using (max 2); after two distinct taps the interaction check runs once. No tap, no query. |

Every user-visible reply carries both mandatory lines from shared constants
in `lib/render.ts`, so no code path can drift. The full string-level audit
is in `docs/wording-audit.md`; the release QA matrix (10 known pairs +
5 not-found pairs × zh/en/ja) is in `docs/qa-matrix-log.md`.

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values
```

| Variable | Purpose |
| --- | --- |
| `DDICBOT_BOT_TOKEN` | Bot token from @BotFather |
| `NEON_DATABASE_URL` | Postgres connection string (Neon pooled endpoint) |
| `TELEGRAM_WEBHOOK_SECRET` | Random token; sent as `X-Telegram-Bot-Api-Secret-Token` on every Telegram webhook POST and compared server-side |
| `CRON_SECRET` | Bearer secret for `/api/cron/refresh` (Vercel Cron sends it automatically; a missing value makes the endpoint return 401) |
| `DDICBOT_VISION_API_KEY` | Moonshot/Kimi (api.moonshot.cn) key for the photo flow; unset → photo replies say the feature is not configured |
| `DDICBOT_VISION_MODEL` | Optional vision model override (default `kimi-k3`) |
| `VERCEL_ACCESS_TOKEN` | Vercel PAT, CI deploys only |

### Webhook

`POST /api/tg-webhook` is the grammY endpoint (not long-polling). It returns
405 for a POST whose secret header is missing or wrong; `GET` is a 200 health
probe. After deploying, register the webhook once:

```bash
node scripts/set-webhook.mjs   # idempotent; reads secrets from the env, prints none
```

or by hand: `setWebhook` with `url=https://<deployment>/api/tg-webhook`,
`secret_token=<TELEGRAM_WEBHOOK_SECRET>`,
`allowed_updates=["message","callback_query"]`. Verify with
`getWebhookInfo` (url correct, `last_error_message` empty).

### Deploy

```bash
vercel link        # or existing .vercel/project.json
vercel env ls      # confirm the secrets above exist in production
vercel --prod      # production deploy (function region should match the Neon region)
node scripts/set-webhook.mjs
```

The daily cron ships in `vercel.json` (`0 6 * * *` → `/api/cron/refresh`):
outside its auth it serves the bounded DB-side catch-ups (FK reconcile, one
translation batch, one JA name-dict batch); the full DDInter re-import runs
off-heap via `scripts/daily-refresh.ts` on a machine that owns `data/`.
Cron contract: `Authorization: Bearer <CRON_SECRET>` → 200, otherwise 401.

### Development

```bash
npm run dev            # local dev server on :3000
npm run build          # production build
npm run typecheck      # tsc --noEmit
npm run test           # node:test via tsx; DB-backed tests need NEON_DATABASE_URL
npx tsx scripts/simulate-check.ts   # acceptance run against real bot + real DB (reply stubbed out)
npx tsx scripts/qa-matrix.ts        # full bilingual QA matrix (build + local prod server)
npx tsx scripts/e2e-prod-final.ts   # production /check E2E (crafted updates, real webhook)
npm run db:migrate     # apply db/schema.sql (idempotent)
npm run import:ddinter # DDInter 2.0 bulk import (idempotent, re-run is a no-op)
npm run build:names    # name dictionary: EN (RxNorm) + ZH (PubChem) + per-language fallback
npm run enrich:zh      # backfill zh rows from the pre-verified Wikidata cache
```

Scripts read credentials from the environment, falling back to `~/.hermes/.env`
(`scripts/_load-env.ts`). Secrets are never hardcoded and the e2e harnesses
redact everything from their written logs.

## Layout

```
app/api/tg-webhook/route.ts   # webhook endpoint (grammY)
app/api/cron/refresh/route.ts # daily refresh (Vercel Cron, Bearer auth)
lib/bot.ts                    # grammY Bot + /start, wires the handlers
lib/render.ts                 # zh/en/ja render + mandatory safety lines (single source of truth)
lib/db.ts                     # process-level pg pool (Neon)
lib/chat-lang.ts              # per-chat UI language, DB-backed (chat_langs)
lib/name-resolve.ts           # exact + pg_trgm fuzzy name → ingredient_id
lib/ddi-query.ts              # bidirectional pair query + display names
lib/vision.ts                 # photo → structured candidates (vision LLM)
lib/vision-map.ts             # LLM names → DB-validated candidates
lib/vision-dl.ts              # Bot API photo download (memory only, no fs)
lib/photo-state.ts            # photo confirmation sessions (photo_sessions table)
lib/env.ts                    # env access
handlers/check.ts             # /check + /lang + /help
handlers/photo.ts             # photo flow; the single DDI call site (tap-gated)
tests/*.test.ts               # unit tests (node:test); DB-backed when DSN present
scripts/simulate-check.ts     # simulated /check acceptance (real bot + real DB)
scripts/qa-matrix.ts          # P3 bilingual QA matrix (docs/qa-matrix-log.md)
scripts/e2e-prod-final.ts     # production E2E against the live webhook
scripts/set-webhook.mjs       # idempotent setWebhook + getWebhookInfo
scripts/daily-refresh.ts      # full daily pipeline (owns data/ on the dev machine)
db/schema.sql                 # canonical schema (drugs, ddi_pairs, drug_names, photo_sessions, chat_langs)
db/migrate.ts                 # applies schema.sql against NEON_DATABASE_URL
data/…                        # gitignored: DDInter CSVs, RxNorm, PubChem caches, e2e fixtures
docs/                         # e2e logs, QA matrix, wording audit
```

## Data sources and license notes

- **DDInter 2.0** — [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/):
  non-commercial use, attribution and share-alike required. Attribution:
  interaction pairs and mechanism text © DDInter (www.ddinter.scbdd.com),
  used under CC BY-NC-SA 4.0. 15 of 26 per-letter category CSVs are
  published; all 15 were imported, covering 236,834 unique unordered pairs
  across 1,972 ingredients. This project is a 公益/self-use clinical
  information bot and does not redistribute the raw dataset.
- **RxNorm** (NLM) — released without restriction on use; the full
  prescribable release (RXNCONSO.RRF) is the EN synonym source.
- **PubChem** (ZH/JA synonyms) — the `heading=Chinese` REST endpoint is the
  named ZH source. An audit (2026-11-25) found its synonym lists carry no
  CJK strings for the tested compounds and that the parameter does not
  filter server-side; `scripts/build-name-dict.ts` therefore keeps only
  CJK-containing synonyms in the `zh` column and fills missing Chinese
  coverage with `source='fallback'` rows. PubChem also carries zero Japanese
  synonyms (probed 2026-11-26), so `lang='ja'` rows are LLM-generated
  standard names with a hand-verified curated seed for the clinically common
  drugs; JA name matching stays exact-first and deterministic.
- **LLM** — used only as a guarded translation/candidate layer (mechanism
  text EN→zh/ja, photo candidate expansion, JA names). It never alters
  severity, pair membership, or the database of record.
- **This repository** — AGPL-3.0 (see `LICENSE`).
