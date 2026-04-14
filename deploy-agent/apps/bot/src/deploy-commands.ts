// Register slash commands with Discord API
// Run: npx tsx apps/bot/src/deploy-commands.ts

import { REST, Routes, SlashCommandBuilder, type SlashCommandStringOption } from 'discord.js';
import { config } from './config.js';

const setProjectOption = (opt: SlashCommandStringOption) =>
  opt.setName('project').setDescription('專案名稱或 slug').setRequired(true).setAutocomplete(true);

const command = new SlashCommandBuilder()
  .setName('deploy')
  .setDescription('Wave Deploy Agent 部署管理')
  .addSubcommand(sub =>
    sub.setName('list').setDescription('列出所有專案')
  )
  .addSubcommand(sub =>
    sub.setName('status').setDescription('查看專案狀態')
      .addStringOption(setProjectOption)
  )
  .addSubcommand(sub =>
    sub.setName('approve').setDescription('核准專案部署')
      .addStringOption(setProjectOption)
      .addStringOption(opt => opt.setName('comments').setDescription('審查備註'))
  )
  .addSubcommand(sub =>
    sub.setName('reject').setDescription('拒絕專案部署')
      .addStringOption(setProjectOption)
      .addStringOption(opt => opt.setName('reason').setDescription('拒絕原因'))
  )
  .addSubcommand(sub =>
    sub.setName('publish').setDescription('發佈指定版本')
      .addStringOption(setProjectOption)
      .addIntegerOption(opt => opt.setName('version').setDescription('版本號').setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('rollback').setDescription('回滾到指定版本')
      .addStringOption(setProjectOption)
      .addIntegerOption(opt => opt.setName('version').setDescription('版本號（留空=回到上一版）'))
  )
  .addSubcommand(sub =>
    sub.setName('lock').setDescription('切換部署鎖定')
      .addStringOption(setProjectOption)
  );

async function main() {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  console.log('Registering slash commands...');

  if (config.guildId) {
    // Guild-scoped (instant update)
    await rest.put(
      Routes.applicationGuildCommands(config.discordAppId, config.guildId),
      { body: [command.toJSON()] },
    );
    console.log(`Registered to guild ${config.guildId}`);
  } else {
    // Global (takes up to 1 hour)
    await rest.put(
      Routes.applicationCommands(config.discordAppId),
      { body: [command.toJSON()] },
    );
    console.log('Registered globally');
  }

  console.log('Done!');
}

main().catch(console.error);
