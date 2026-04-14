import type { ChatInputCommandInteraction } from 'discord.js';
import { findProjectBySlug, listReviews, decideReview } from '../api-client.js';

export async function handleApprove(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const slug = interaction.options.getString('project', true);
  const comments = interaction.options.getString('comments') ?? undefined;

  try {
    const project = await findProjectBySlug(slug);
    if (!project) {
      await interaction.editReply(`❌ 找不到專案: \`${slug}\``);
      return;
    }

    if (project.status !== 'review_pending') {
      await interaction.editReply(`⚠️ **${project.name}** 目前狀態是 \`${project.status}\`，不需要審查。`);
      return;
    }

    // Find pending review for this project
    const reviews = await listReviews();
    const pendingReview = reviews.find(
      r => r.project_slug === project.slug && !r.decision
    );

    if (!pendingReview) {
      await interaction.editReply(`⚠️ 找不到 **${project.name}** 的待審查項目。`);
      return;
    }

    const email = `discord:${interaction.user.username}`;
    await decideReview(pendingReview.id, 'approved', email, comments);

    await interaction.editReply(
      `✅ **${project.name}** 已核准！部署流程開始中...\n` +
      `審查者: ${interaction.user.username}`
    );
  } catch (err) {
    await interaction.editReply(`❌ 核准失敗: ${(err as Error).message}`);
  }
}

export async function handleReject(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const slug = interaction.options.getString('project', true);
  const reason = interaction.options.getString('reason') ?? 'Rejected via Discord';

  try {
    const project = await findProjectBySlug(slug);
    if (!project) {
      await interaction.editReply(`❌ 找不到專案: \`${slug}\``);
      return;
    }

    const reviews = await listReviews();
    const pendingReview = reviews.find(
      r => r.project_slug === project.slug && !r.decision
    );

    if (!pendingReview) {
      await interaction.editReply(`⚠️ 找不到 **${project.name}** 的待審查項目。`);
      return;
    }

    const email = `discord:${interaction.user.username}`;
    await decideReview(pendingReview.id, 'rejected', email, reason);

    await interaction.editReply(
      `🚫 **${project.name}** 已拒絕。\n` +
      `原因: ${reason}\n` +
      `審查者: ${interaction.user.username}`
    );
  } catch (err) {
    await interaction.editReply(`❌ 拒絕失敗: ${(err as Error).message}`);
  }
}
