# DDICBot

Telegram bot for drug–drug interaction (DDI) lookup, built on
[Next.js](https://nextjs.org/) (App Router) + TypeScript +
[grammY](https://grammy.dev/) webhook.

Data source: [DDInter 2.0](https://ddinter.scbdd.com/download/) (CC BY-NC-SA
4.0, non-commercial) — 15 of 26 per-letter category CSVs are currently
published, covering ~237k unique unordered pairs (1,972 ingredients).
The site only links 8 of the 15; the other 7 were recovered by probing the
per-letter URL pattern. Name dictionaries: RxNorm (EN) + Wikidata labels
(ZH). Database: Neon Postgres with `pg_trgm` fuzzy matching.

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

## Development

```bash
npm run dev           # local dev server on :3000
npm run build         # production build
npx tsc --noEmit      # type check
npm run db:migrate    # apply db/schema.sql (idempotent)
npm run db:import     # DDInter 2.0 bulk import (idempotent)
npm run db:names      # name dictionary: EN baseline + RxNorm synonyms
npx tsx scripts/build-name-dict.ts --zh   # additionally fetch ZH labels (Wikidata)
```

The scripts read `NEON_DATABASE_URL` from the environment, falling back to
`~/.hermes/.env` (see `scripts/_load-env.ts`). Secrets are never hardcoded.

## Layout

```
app/api/tg-webhook/route.ts   # webhook endpoint (grammY)
lib/bot.ts                    # grammY Bot + command handlers
lib/env.ts                    # env access
db/schema.sql                 # canonical schema (drugs, ddi_pairs, drug_names)
db/migrate.ts                 # applies schema.sql against NEON_DATABASE_URL
scripts/import-ddinter.ts     # DDInter 2.0 bulk import (idempotent)
scripts/build-name-dict.ts    # RxNorm/Wikidata name dictionary upsert
scripts/verify-import.ts      # post-import counts + known-pair spot checks
data/ddinter/                 # gitignored: DDInter 2.0 raw CSVs
data/rxnorm/                  # gitignored: RxNorm release files
data/pubchem/                 # gitignored: PubChem fetch caches
data/name-dict/               # gitignored: ZH cache from Wikidata lookups
```

## Data sources and license notes

- **DDInter 2.0** — CC BY-NC-SA 4.0: non-commercial use, attribution and
  share-alike required. This project is a 公益/self-use clinical information
  bot and does not redistribute the raw dataset.
- **RxNorm** (NLM) — released without restriction on use; the full
  prescribable release (RXNCONSO.RRF) is the EN synonym source.
- **Wikidata** (ZH labels) — content licensed CC BY-SA 4.0. Wikidata is used
  as the ZH source after an audit (2026-11-24) found no CJK strings in the
  PubChem synonym lists of the tested compounds, so PubChem is not the ZH
  source despite the earlier plan.
