// Wave Deploy Agent — Discord Bot
// Slash commands + natural language + deploy management via Discord

import { createServer } from 'node:http';
import { Client, GatewayIntentBits, Events, type TextChannel } from 'discord.js';
import { config } from './config.js';
import { handleCommand, handleAutocomplete } from './commands/index.js';
import { handleNaturalLanguage, startMorningDigest } from './nl-handler.js';
import { checkMessageGate } from './message-gate-verdict.js';

// Cloud Run requires a listening HTTP port — minimal health check server
const port = parseInt(process.env.PORT ?? '8080', 10);
const healthServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', bot: client.isReady() ? 'connected' : 'connecting' }));
});
healthServer.listen(port, () => console.log(`[Bot] Health server on :${port}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[Bot] Ready as ${c.user.tag}`);
  console.log(`[Bot] API: ${config.apiBaseUrl}`);
  console.log(`[Bot] Guilds: ${c.guilds.cache.size}`);
  console.log(`[Bot] NL: ${config.anthropicApiKey ? 'enabled' : 'disabled'}`);

  // Start morning digest if channel is configured
  if (config.channelId) {
    startMorningDigest(async (content, embeds) => {
      const channel = await c.channels.fetch(config.channelId) as TextChannel | null;
      if (channel) await channel.send({ content: content || undefined, embeds });
    });
    console.log(`[Bot] Digest: channel ${config.channelId}, hour ${config.digestHour}`);
  }
});

// Slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'deploy') {
      await handleCommand(interaction);
    } else if (interaction.isAutocomplete() && interaction.commandName === 'deploy') {
      await handleAutocomplete(interaction);
    }
  } catch (err) {
    console.error('[Bot] Interaction error:', (err as Error).message);
    try {
      if (interaction.isRepliable()) {
        const msg = `❌ 內部錯誤: ${(err as Error).message}`;
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(msg);
        } else {
          await interaction.reply({ content: msg, ephemeral: true });
        }
      }
    } catch {
      // Can't respond, ignore
    }
  }
});

// Natural language messages
client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Round 26: message gate — @mention OR DM OR ops-channel.
  // Silent ignore for everything else (no spam in shared channels).
  const verdict = checkMessageGate({
    isMentioned: message.mentions.has(client.user!),
    isDM: !message.guild,
    channelId: message.channelId,
    opsChannelIds: config.opsChannelIds,
  });
  if (verdict.kind === 'denied-not-mentioned-no-ops') return;

  try {
    await handleNaturalLanguage(message);
  } catch (err) {
    console.error('[Bot] NL error:', (err as Error).message);
    try {
      await message.reply(`❌ 處理失敗：${(err as Error).message}`);
    } catch {
      // Can't respond, ignore
    }
  }
});

// Login
client.login(config.discordToken).catch((err) => {
  console.error('[Bot] Login failed:', err);
  process.exit(1);
});
