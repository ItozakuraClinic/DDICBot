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
}

export function loadEnv(): DdicBotEnv {
  return {
    botToken: process.env.DDICBOT_BOT_TOKEN,
    databaseUrl: process.env.NEON_DATABASE_URL,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  };
}
