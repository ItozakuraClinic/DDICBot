# DDICBot

Telegram bot for drug–drug interaction (DDI) lookup, built on
[Next.js](https://nextjs.org/) (App Router) + TypeScript +
[grammY](https://grammy.dev/) webhook.

Data source: [DDInter 2.0](https://ddinter.scbdd.com/download/) (CC BY-NC-SA
4.0, non-commercial) — 15 of 26 per-letter category CSVs are currently
published, covering ~237k unique unordered pairs (1,972 ingredients).
The site only links 8 of the 15; the other 7 were recovered by probing the
per-letter URL pattern. Name dictionaries: RxNorm (EN) + PubChem (ZH,
see the CJK audit note in `scripts/build-name-dict.ts`). Database: Neon
Postgres with `pg_trgm` fuzzy matching.

## Webhook

`POST /api/tg-webhook` — grammY webhook endpoint (not long-polling). It
validates the `X-Telegram-Bot-Api-Secret-Token` header against
`TELEGRAM_WEBHOOK_SECRET` and rejects unauthorized POSTs with `405`.
`GET /api/tg-webhook` is a 200 health probe.

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values
```

| Variable | Purpose |
| --- | --- |
| `DDICBOT_BOT_TOKEN` | Bot token from @BotFather |
| `NEON_DATABASE_URL` | Postgres connection string (Neon pooled endpoint) |
| `TELEGRAM_WEBHOOK_SECRET` | Random webhook secret token |
| `VERCEL_ACCESS_TOKEN` | Vercel PAT (CI deploys only) |

Before sending updates, register the webhook against your deployed URL with
`secret_token` set to `TELEGRAM_WEBHOOK_SECRET`.

## Bot commands

| Command | Behavior |
| --- | --- |
| `/check <drug1> <drug2>` | Space or comma separated. Resolves each name (exact, then `pg_trgm` fuzzy, threshold 0.3) and renders the DDI row: severity badge (🔴 Major / 🟡 Moderate / 🟢 Minor / ⚪ Unknown), mechanism (when the source has it), and the resolved pair. |
| `/lang en \| zh` | Sets the reply language for the chat (default zh; ja accepted, display follows P3). In-memory until a persistent store lands. |
| `/help`, `/start` | Command list; welcome + usage. |

Every reply carries the two mandatory lines — emergency numbers
(120 / 911 / 119) and `⚠️ 非医疗建议 / Not medical advice` — from the shared
`lib/render.ts` constants, so no code path can drift.

**Not-found semantics (safety rule):** when `ddi_pairs` has no row, the reply
renders `数据库未收录该组合，不代表无相互作用。` — never "no interaction" or
"safe". Unresolvable drug names get a candidate list and a re-type/photo
prompt (photo flow is P2).

## Development

```bash
npm run dev           # local dev server on :3000
npm run build         # production build
npm run typecheck     # tsc --noEmit
npm run test          # unit tests (node:test via tsx); DB-backed tests need NEON_DATABASE_URL
npx tsx scripts/simulate-check.ts   # simulated /check acceptance run (real bot + real DB, stubbed Bot API)
npm run db:migrate    # apply db/schema.sql (idempotent)
npm run import:ddinter  # DDInter 2.0 bulk import (idempotent)
npm run build:names     # name dictionary: EN (RxNorm) + ZH (PubChem) + per-language fallback
npx tsx scripts/build-name-dict.ts --limit 25  # smoke test (first 25 ingredients)
npx tsx scripts/build-name-dict.ts --dry-run   # build + report, no DB writes
```

The scripts read `NEON_DATABASE_URL` from the environment, falling back to
`~/.hermes/.env` (see `scripts/_load-env.ts`). Secrets are never hardcoded.

## Layout

```
app/api/tg-webhook/route.ts   # webhook endpoint (grammY)
lib/bot.ts                    # grammY Bot + /start, wires P1T7 handlers
lib/render.ts                 # bilingual render + mandatory safety lines (single source of truth)
lib/db.ts                     # process-level pg pool (Neon)
lib/name-resolve.ts           # P1T5: exact + pg_trgm fuzzy name → ingredient_id
lib/ddi-query.ts              # P1T6: bidirectional pair query + display names
lib/env.ts                    # env access
handlers/check.ts             # P1T7: /check + /lang command handlers
tests/*.test.ts               # unit tests (node:test); DB-backed when DSN present
scripts/simulate-check.ts     # simulated /check acceptance (real bot + real DB)
db/schema.sql                 # canonical schema (drugs, ddi_pairs, drug_names)
db/migrate.ts                 # applies schema.sql against NEON_DATABASE_URL
scripts/import-ddinter.ts     # DDInter 2.0 bulk import (idempotent)
scripts/build-name-dict.ts    # EN (RxNorm) + ZH (PubChem) name dictionary upsert
scripts/verify-import.ts      # post-import counts + known-pair spot checks
data/ddinter/                 # gitignored: DDInter 2.0 raw CSVs
data/rxnorm/                  # gitignored: RxNorm release files
data/pubchem/                 # gitignored: PubChem fetch caches (incl. ZH lookup cache)
```

## Data sources and license notes

- **DDInter 2.0** — CC BY-NC-SA 4.0: non-commercial use, attribution and
  share-alike required. This project is a 公益/self-use clinical information
  bot and does not redistribute the raw dataset.
- **RxNorm** (NLM) — released without restriction on use; the full
  prescribable release (RXNCONSO.RRF) is the EN synonym source.
- **PubChem** (ZH synonyms) — the `heading=Chinese` REST endpoint is the
  named ZH source. An audit (2026-11-25) found its synonym lists carry no
  CJK (Chinese) strings for the tested compounds and that the
  `heading=Chinese` parameter does not filter server-side; the script
  therefore keeps only CJK-containing synonyms in the `zh` column and
  fills Chinese coverage with `source='fallback'` rows (the ingredient's
  canonical English name) where no genuine Chinese synonym exists.
  Details: header of `scripts/build-name-dict.ts`.
