import type { ChatInputCommandInteraction } from 'discord.js';
import { listProjects } from '../api-client.js';
import { projectListEmbed } from '../embeds/project-embed.js';

export async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  try {
    const projects = await listProjects();
    await interaction.editReply({ embeds: [projectListEmbed(projects)] });
  } catch (err) {
    await interaction.editReply(`❌ 無法取得專案列表: ${(err as Error).message}`);
  }
}
