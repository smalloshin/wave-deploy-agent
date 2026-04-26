import 'dotenv/config';

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? '',
  discordAppId: process.env.DISCORD_APP_ID ?? '',
  guildId: process.env.DISCORD_GUILD_ID ?? '',       // Guild-scoped commands (instant update)
  channelId: process.env.DISCORD_CHANNEL_ID ?? '',   // Channel for notifications
  apiBaseUrl: process.env.API_BASE_URL ?? 'https://wave-deploy-agent-api.punwave.com',
  apiKey: process.env.DEPLOY_AGENT_API_KEY ?? '',  // When set, all API calls include Authorization: Bearer (RBAC Phase 2)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  digestHour: parseInt(process.env.DIGEST_HOUR ?? '9', 10), // Morning digest hour (24h format)
  // Round 26: operator allowlist — only Discord user IDs in this list can use NL.
  // Empty = open mode (warn at boot, allow all). Comma-separated snowflakes.
  operatorDiscordIds: (process.env.OPERATOR_DISCORD_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Round 26: ops channel allowlist — drops the @mention requirement in these
  // channels (any message from any operator gets handled). Empty = strict
  // @mention/DM-only mode. Comma-separated snowflakes.
  opsChannelIds: (process.env.OPS_CHANNEL_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
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

if (!config.apiKey) {
  console.warn('[config] DEPLOY_AGENT_API_KEY not set — requests will be anonymous (OK in permissive mode; will 401 in enforced mode)');
}
