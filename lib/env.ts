/**
 * Environment access for DDICBot.
 *
 * Values come from the process environment (Vercel / .env in dev). Never
 * hardcode credentials; `.env.example` lists the required keys.
 */
export interface DdicBotEnv {
  botToken: string | undefined;
  databaseUrl: string | undefined;
  webhookSecret: string | undefined;
  /** Vision LLM API key (Moonshot / Kimi CN). Undefined → vision 503 path. */
  visionApiKey: string | undefined;
  /** Vision model override; default "kimi-k3" (see lib/vision.ts). */
  visionModel: string | undefined;
}

export function loadEnv(): DdicBotEnv {
  return {
    botToken: process.env.DDICBOT_BOT_TOKEN,
    databaseUrl: process.env.NEON_DATABASE_URL,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    visionApiKey: process.env.DDICBOT_VISION_API_KEY,
    visionModel: process.env.DDICBOT_VISION_MODEL,
  };
}
