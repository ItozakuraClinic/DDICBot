// setWebhook + getWebhookInfo (prod). Reads credentials in-process; never
// prints secret values.
//
// Credentials:
//   DDICBOT_BOT_TOKEN       from ~/.hermes/.env (or process env override)
//   TELEGRAM_WEBHOOK_SECRET from <repo>/data/webhook-secret-prod.txt
//     (gitignored local ops copy of the Vercel production secret;
//      generate with: openssl rand -hex 24 > data/webhook-secret-prod.txt,
//      chmod 600, and set the same value as Vercel env TELEGRAM_WEBHOOK_SECRET)
//
// Usage: node scripts/set-webhook.mjs   (idempotent — safe to re-run)
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function parseEnv(p) {
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const dotenv = { ...parseEnv(`${homedir()}/.hermes/.env`) };
const BOT = process.env.DDICBOT_BOT_TOKEN || dotenv.DDICBOT_BOT_TOKEN;
const wsPath = `${repoRoot}data/webhook-secret-prod.txt`;
const WS = process.env.TELEGRAM_WEBHOOK_SECRET || (existsSync(wsPath) ? readFileSync(wsPath, "utf8").trim() : "");
if (!BOT || !WS) {
  console.log("MISSING credentials: DDICBOT_BOT_TOKEN (~/.hermes/.env) or TELEGRAM_WEBHOOK_SECRET (data/webhook-secret-prod.txt).");
  process.exit(2);
}
const base = `https://api.telegram.org/bot${BOT}`;
const red = (s) => String(s).replace(BOT, "BOT_TOKEN_REDACTED").replace(WS, "WEBHOOK_SECRET_REDACTED");

async function tgDirect(method, body) {
  const r = await fetch(`${base}/${method}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j; try { j = await r.json(); } catch { j = { raw: (await r.text()).slice(0, 200) }; }
  return { http: r.status, j };
}
async function tg(method, body) {
  try { return await tgDirect(method, body); }
  catch {
    // WSL egress: fall back to the local mihomo proxy (api.telegram.org is
    // SNI-polluted on the direct line).
    const { ProxyAgent } = await import("undici");
    const r = await fetch(`${base}/${method}`, {
      method: body ? "POST" : "GET",
      dispatcher: new ProxyAgent("http://127.0.0.1:7890"),
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j; try { j = await r.json(); } catch { j = { raw: (await r.text()).slice(0, 200) }; }
    return { http: r.status, j, via: "proxy" };
  }
}

const PROD_URL = "https://ddicbot.vercel.app/api/tg-webhook";

const me = await tg("getMe");
console.log("getMe:", red(JSON.stringify(me.j)).slice(0, 220));

const set = await tg("setWebhook", {
  url: PROD_URL,
  drop_pending_updates: true,
  secret_token: WS,
  // P2: photos ride on "message", inline-keyboard taps on "callback_query".
  allowed_updates: ["message", "callback_query"],
});
console.log("setWebhook http:", set.http, red(JSON.stringify(set.j)));

const info = await tg("getWebhookInfo");
console.log("getWebhookInfo http:", info.http);
console.log(red(JSON.stringify(info.j, null, 1)));

const ok = set.http === 200 && set.j.ok === true
  && info.j?.ok === true
  && info.j?.result?.url === PROD_URL
  && !info.j?.result?.last_error_message;
console.log("WEBHOOK_OK=" + ok);
if (info.j?.result?.last_error_message) console.log("NOTE last_error_message:", info.j.result.last_error_message);
process.exit(ok ? 0 : 1);
