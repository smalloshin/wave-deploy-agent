import 'dotenv/config';

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? '',
  discordAppId: process.env.DISCORD_APP_ID ?? '',
  guildId: process.env.DISCORD_GUILD_ID ?? '',       // Guild-scoped commands (instant update)
  channelId: process.env.DISCORD_CHANNEL_ID ?? '',   // Channel for notifications
  apiBaseUrl: process.env.API_BASE_URL ?? 'https://wave-deploy-agent-api.punwave.com',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  digestHour: parseInt(process.env.DIGEST_HOUR ?? '9', 10), // Morning digest hour (24h format)
};

// Validate required config
const required = ['discordToken', 'discordAppId'] as const;
for (const key of required) {
  if (!config[key]) {
    console.error(`Missing required env var for ${key}`);
    process.exit(1);
  }
}

if (!config.anthropicApiKey && !config.openaiApiKey) {
  console.warn('[config] No LLM API key set — natural language input disabled');
}
