import { EmbedBuilder } from 'discord.js';
import type { Project, DeployVersion } from '../api-client.js';

// Status → color mapping
const STATUS_COLORS: Record<string, number> = {
  live: 0x3fb950,         // green
  deploying: 0x58a6ff,    // blue
  scanning: 0xe3b341,     // yellow
  review_pending: 0xd29922, // orange
  failed: 0xf85149,       // red
  stopped: 0x8b949e,      // gray
};

export function projectListEmbed(projects: Project[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('Wave Deploy Agent — 專案列表')
    .setColor(0x58a6ff)
    .setTimestamp();

  if (projects.length === 0) {
    embed.setDescription('目前沒有專案。');
    return embed;
  }

  const lines = projects.map(p => {
    const statusEmoji = p.status === 'live' ? '🟢' :
                       p.status === 'failed' ? '🔴' :
                       p.status === 'deploying' ? '🔵' :
                       p.status === 'review_pending' ? '🟡' :
                       p.status === 'scanning' ? '🟡' : '⚪';
    const domain = (p.config?.customDomain as string) ?? '';
    return `${statusEmoji} **${p.name}** — \`${p.status}\`${domain ? ` — ${domain}` : ''}`;
  });

  embed.setDescription(lines.join('\n'));
  embed.setFooter({ text: `共 ${projects.length} 個專案` });
  return embed;
}

export function projectStatusEmbed(project: Project, versions?: DeployVersion[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${project.name}`)
    .setColor(STATUS_COLORS[project.status] ?? 0x8b949e)
    .setTimestamp();

  const domain = (project.config?.customDomain as string) || 'N/A';
  const lang = project.detectedLanguage ?? 'N/A';
  const framework = project.detectedFramework ?? 'N/A';

  embed.addFields(
    { name: '狀態', value: `\`${project.status}\``, inline: true },
    { name: '語言', value: lang, inline: true },
    { name: '框架', value: framework, inline: true },
    { name: '網域', value: domain, inline: true },
    { name: 'Slug', value: `\`${project.slug}\``, inline: true },
  );

  if (versions && versions.length > 0) {
    const vLines = versions.slice(0, 5).map(v => {
      const pub = v.isPublished ? ' **LIVE**' : '';
      const health = v.healthStatus === 'healthy' ? '✅' : v.healthStatus === 'unhealthy' ? '❌' : '❓';
      const preview = v.previewUrl && v.previewUrl.includes('---')
        ? ` [Preview](${v.previewUrl})`
        : '';
      return `v${v.version} ${health}${pub}${preview}`;
    });
    embed.addFields({ name: '版本歷史', value: vLines.join('\n') || 'N/A' });
  }

  return embed;
}

export function deployCompleteEmbed(
  project: Project,
  version: number,
  serviceUrl: string,
  previewUrl?: string,
  canaryPassed?: boolean,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`✅ 部署完成 — ${project.name} v${version}`)
    .setColor(0x3fb950)
    .setTimestamp();

  embed.addFields(
    { name: '狀態', value: '`live`', inline: true },
    { name: 'Canary', value: canaryPassed ? '✅ 通過' : '⚠️ 有警告', inline: true },
  );

  if (serviceUrl) {
    embed.addFields({ name: 'URL', value: serviceUrl });
  }
  if (previewUrl && previewUrl.includes('---')) {
    embed.addFields({ name: 'Preview', value: previewUrl });
  }

  return embed;
}

export function canaryFailedEmbed(
  project: Project,
  version: number,
  failures: string,
  rolledBackTo?: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Canary 失敗 — ${project.name} v${version}`)
    .setColor(0xf85149)
    .setTimestamp();

  embed.addFields(
    { name: '失敗項目', value: `\`\`\`\n${failures}\n\`\`\`` },
  );

  if (rolledBackTo) {
    embed.addFields({ name: '自動回滾', value: `已回滾至 ${rolledBackTo}` });
  }

  return embed;
}

export function reviewNeededEmbed(
  projectName: string,
  projectSlug: string,
  reviewId: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`🔍 需要審查 — ${projectName}`)
    .setColor(0xd29922)
    .setDescription(`專案 **${projectName}** 的安全掃描已完成，等待審查。`)
    .addFields(
      { name: '審查 ID', value: `\`${reviewId}\``, inline: true },
      { name: '操作', value: `\`/deploy approve ${projectSlug}\` 或 \`/deploy reject ${projectSlug}\`` },
    )
    .setTimestamp();
}

export function deployFailedEmbed(
  projectName: string,
  error: string,
  step: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`❌ 部署失敗 — ${projectName}`)
    .setColor(0xf85149)
    .addFields(
      { name: '失敗步驟', value: step, inline: true },
      { name: '錯誤', value: `\`\`\`\n${error.slice(0, 1000)}\n\`\`\`` },
    )
    .setTimestamp();
}
