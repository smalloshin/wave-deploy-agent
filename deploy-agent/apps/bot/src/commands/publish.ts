import type { ChatInputCommandInteraction } from 'discord.js';
import { findProjectBySlug, getVersions, publishVersion, toggleDeployLock } from '../api-client.js';

export async function handlePublish(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const slug = interaction.options.getString('project', true);
  const versionNum = interaction.options.getInteger('version', true);

  try {
    const project = await findProjectBySlug(slug);
    if (!project) {
      await interaction.editReply(`❌ 找不到專案: \`${slug}\``);
      return;
    }

    const { versions } = await getVersions(project.id);
    const target = versions.find(v => v.version === versionNum);
    if (!target) {
      const available = versions.map(v => `v${v.version}`).join(', ');
      await interaction.editReply(`❌ 找不到 v${versionNum}。可用版本: ${available}`);
      return;
    }

    if (!target.revisionName) {
      await interaction.editReply(`❌ v${versionNum} 沒有 Cloud Run revision，無法發佈。`);
      return;
    }

    const result = await publishVersion(project.id, target.id);

    const emoji = result.isRollback ? '⏪' : '🚀';
    const action = result.isRollback ? '回滾' : '發佈';
    await interaction.editReply(
      `${emoji} **${project.name}** 已${action}至 v${result.version}\n` +
      `Revision: \`${result.revisionName}\``
    );
  } catch (err) {
    await interaction.editReply(`❌ 發佈失敗: ${(err as Error).message}`);
  }
}

export async function handleRollback(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const slug = interaction.options.getString('project', true);
  const versionNum = interaction.options.getInteger('version');

  try {
    const project = await findProjectBySlug(slug);
    if (!project) {
      await interaction.editReply(`❌ 找不到專案: \`${slug}\``);
      return;
    }

    const { versions } = await getVersions(project.id);

    // If no version specified, rollback to previous published version
    let target;
    if (versionNum) {
      target = versions.find(v => v.version === versionNum);
    } else {
      // Find current published, then get the one before it
      const publishedIdx = versions.findIndex(v => v.isPublished);
      if (publishedIdx >= 0 && publishedIdx + 1 < versions.length) {
        target = versions[publishedIdx + 1]; // next older version
      }
    }

    if (!target) {
      await interaction.editReply(`❌ 找不到可回滾的版本。`);
      return;
    }

    if (!target.revisionName) {
      await interaction.editReply(`❌ v${target.version} 沒有 Cloud Run revision。`);
      return;
    }

    const result = await publishVersion(project.id, target.id);
    await interaction.editReply(
      `⏪ **${project.name}** 已回滾至 v${result.version}\n` +
      `Revision: \`${result.revisionName}\``
    );
  } catch (err) {
    await interaction.editReply(`❌ 回滾失敗: ${(err as Error).message}`);
  }
}

export async function handleLock(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const slug = interaction.options.getString('project', true);

  try {
    const project = await findProjectBySlug(slug);
    if (!project) {
      await interaction.editReply(`❌ 找不到專案: \`${slug}\``);
      return;
    }

    const result = await toggleDeployLock(project.id);
    const emoji = result.deployLocked ? '🔒' : '🔓';
    await interaction.editReply(`${emoji} **${project.name}** — ${result.message}`);
  } catch (err) {
    await interaction.editReply(`❌ 鎖定切換失敗: ${(err as Error).message}`);
  }
}
