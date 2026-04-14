import type { ChatInputCommandInteraction } from 'discord.js';
import { findProjectBySlug, getVersions } from '../api-client.js';
import { projectStatusEmbed } from '../embeds/project-embed.js';

export async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const slug = interaction.options.getString('project', true);

  try {
    const project = await findProjectBySlug(slug);
    if (!project) {
      await interaction.editReply(`❌ 找不到專案: \`${slug}\``);
      return;
    }

    let versions;
    try {
      const data = await getVersions(project.id);
      versions = data.versions;
    } catch {
      // versions endpoint might fail for projects without deployments
    }

    await interaction.editReply({ embeds: [projectStatusEmbed(project, versions)] });
  } catch (err) {
    await interaction.editReply(`❌ 錯誤: ${(err as Error).message}`);
  }
}
