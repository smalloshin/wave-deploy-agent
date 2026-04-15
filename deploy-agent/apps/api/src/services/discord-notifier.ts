// Discord webhook notifier — fire-and-forget push notifications
// Uses native fetch, zero dependencies. No-ops if DISCORD_WEBHOOK_URL is not set.

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

interface DiscordEmbed {
  title: string;
  color: number;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
}

async function postToDiscord(embeds: DiscordEmbed[]): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds }),
    });
  } catch (err) {
    console.warn('[Discord] Webhook failed:', (err as Error).message);
  }
}

// ─── Notification functions ───

export async function notifyReviewNeeded(
  projectName: string,
  projectSlug: string,
  reviewId: string,
): Promise<void> {
  await postToDiscord([{
    title: `🔍 需要審查 — ${projectName}`,
    color: 0xd29922,
    description: `專案 **${projectName}** 的安全掃描已完成，等待審查。`,
    fields: [
      { name: '操作', value: `/deploy approve ${projectSlug}` },
      { name: '審查 ID', value: `\`${reviewId}\``, inline: true },
    ],
    timestamp: new Date().toISOString(),
  }]);
}

export async function notifyDeployComplete(
  projectName: string,
  version: number,
  serviceUrl: string,
  previewUrl?: string,
  canaryPassed?: boolean,
): Promise<void> {
  const fields = [
    { name: '版本', value: `v${version}`, inline: true },
    { name: 'Canary', value: canaryPassed ? '✅ 通過' : '⚠️ 有警告', inline: true },
    { name: 'URL', value: serviceUrl },
  ];
  if (previewUrl && previewUrl.includes('---')) {
    fields.push({ name: 'Preview', value: previewUrl });
  }

  await postToDiscord([{
    title: `✅ 部署完成 — ${projectName} v${version}`,
    color: 0x3fb950,
    fields,
    timestamp: new Date().toISOString(),
  }]);
}

export async function notifyCanaryFailed(
  projectName: string,
  version: number,
  failures: string,
  rolledBackTo?: string,
): Promise<void> {
  const fields = [
    { name: '版本', value: `v${version}`, inline: true },
    { name: '失敗項目', value: `\`\`\`\n${failures.slice(0, 900)}\n\`\`\`` },
  ];
  if (rolledBackTo) {
    fields.push({ name: '自動回滾', value: `已回滾至 ${rolledBackTo}` });
  }

  await postToDiscord([{
    title: `⚠️ Canary 失敗 — ${projectName} v${version}`,
    color: 0xf85149,
    fields,
    timestamp: new Date().toISOString(),
  }]);
}

export async function notifyDeployFailed(
  projectName: string,
  error: string,
  step: string,
  buildDiagnosis?: {
    category: string;
    summary: string;
    rootCause: string;
    suggestedFix: string;
    errorLocation: string | null;
    provider: string;
  },
): Promise<void> {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: '失敗步驟', value: step, inline: true },
  ];

  if (buildDiagnosis) {
    const categoryLabels: Record<string, string> = {
      user_code: '🔧 程式碼錯誤',
      dependency: '📦 套件/依賴問題',
      config: '⚙️ 設定問題',
      infra: '☁️ 基礎設施問題',
      unknown: '❓ 未知',
    };
    fields.push({ name: '問題類型', value: categoryLabels[buildDiagnosis.category] ?? buildDiagnosis.category, inline: true });
    fields.push({ name: '原因分析', value: buildDiagnosis.rootCause.slice(0, 500) });
    if (buildDiagnosis.errorLocation) {
      fields.push({ name: '錯誤位置', value: `\`${buildDiagnosis.errorLocation}\``, inline: true });
    }
    fields.push({ name: '💡 修復建議', value: buildDiagnosis.suggestedFix.slice(0, 500) });
    fields.push({ name: 'AI 分析', value: `by ${buildDiagnosis.provider}`, inline: true });
  } else {
    fields.push({ name: '錯誤', value: `\`\`\`\n${error.slice(0, 900)}\n\`\`\`` });
  }

  await postToDiscord([{
    title: `❌ 部署失敗 — ${projectName}`,
    color: 0xf85149,
    fields,
    timestamp: new Date().toISOString(),
  }]);
}
