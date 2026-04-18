// Natural language handler — LLM tool_use for intent parsing
// Primary: Claude | Fallback: OpenAI GPT
// Supports: 7 deploy commands, confirmation buttons, context memory, smart suggestions

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  type Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageComponentInteraction,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';
import { config } from './config.js';
import {
  listProjects,
  findProjectBySlug,
  getVersions,
  publishVersion,
  toggleDeployLock,
  listReviews,
  decideReview,
  getScanReport,
} from './api-client.js';
import { projectListEmbed, projectStatusEmbed } from './embeds/project-embed.js';

// ─── LLM Clients (Claude primary, GPT fallback) ───

const anthropic = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
const openai = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null;

// ─── Context Memory (per-channel, last 5 exchanges) ───

interface ContextEntry {
  role: 'user' | 'assistant';
  content: string;
}

const channelMemory = new Map<string, ContextEntry[]>();
const MAX_CONTEXT = 5; // pairs

function getContext(channelId: string): ContextEntry[] {
  return channelMemory.get(channelId) ?? [];
}

function addContext(channelId: string, userMsg: string, assistantMsg: string): void {
  const ctx = channelMemory.get(channelId) ?? [];
  ctx.push({ role: 'user', content: userMsg });
  ctx.push({ role: 'assistant', content: assistantMsg });
  // Keep last MAX_CONTEXT pairs (MAX_CONTEXT * 2 entries)
  while (ctx.length > MAX_CONTEXT * 2) ctx.splice(0, 2);
  channelMemory.set(channelId, ctx);
  // LRU eviction: max 100 channels
  if (channelMemory.size > 100) {
    const oldest = channelMemory.keys().next().value;
    if (oldest) channelMemory.delete(oldest);
  }
}

// ─── Tool Definitions ───

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_projects',
    description: '列出所有專案。當使用者想看所有專案、專案列表時使用。',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_project_status',
    description: '查看某個專案的狀態和版本資訊。當使用者問某個專案的狀態、健康度、版本時使用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: '專案名稱或 slug（例如 luca、bid-ops-ai）' },
      },
      required: ['project'],
    },
  },
  {
    name: 'approve_deploy',
    description: '核准一個待審查的專案部署。當使用者想 approve、通過、核准某個專案時使用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: '專案名稱或 slug' },
        comments: { type: 'string', description: '審查備註（可選）' },
      },
      required: ['project'],
    },
  },
  {
    name: 'reject_deploy',
    description: '拒絕一個待審查的專案部署。當使用者想 reject、拒絕某個專案時使用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: '專案名稱或 slug' },
        reason: { type: 'string', description: '拒絕原因（可選）' },
      },
      required: ['project'],
    },
  },
  {
    name: 'publish_version',
    description: '發佈指定版本到 production，讓該版本接收 100% 流量。當使用者想 publish、上線、發佈某個版本時使用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: '專案名稱或 slug' },
        version: { type: 'number', description: '版本號（例如 3）' },
      },
      required: ['project', 'version'],
    },
  },
  {
    name: 'rollback_version',
    description: '回滾到指定版本。當使用者想 rollback、回滾、退回上一版時使用。如果沒指定版本號，回到上一個 published 版本。',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: '專案名稱或 slug' },
        version: { type: 'number', description: '目標版本號（可選，不填則回到上一版）' },
      },
      required: ['project'],
    },
  },
  {
    name: 'toggle_deploy_lock',
    description: '切換部署鎖定狀態。鎖定後新部署不會自動上線。當使用者想鎖定、解鎖部署時使用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: '專案名稱或 slug' },
      },
      required: ['project'],
    },
  },
];

const DANGEROUS_TOOLS = new Set(['publish_version', 'rollback_version', 'toggle_deploy_lock']);

// ─── OpenAI Tool Format ───

const OPENAI_TOOLS: OpenAI.ChatCompletionTool[] = TOOLS.map(t => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema as Record<string, unknown>,
  },
}));

// ─── Unified LLM Call ───

interface LLMToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface LLMResult {
  toolCalls: LLMToolCall[];
  textReply: string | null;
  provider: 'claude' | 'gpt';
}

async function callLLM(
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<LLMResult> {
  // Try Claude first
  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      });

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );

      return {
        toolCalls: toolUseBlocks.map(b => ({ name: b.name, input: b.input as Record<string, unknown> })),
        textReply: textBlocks.map(b => b.text).join('\n') || null,
        provider: 'claude',
      };
    } catch (err) {
      const msg = (err as Error).message;
      // Only fallback on billing/auth errors, not on transient errors
      if (!openai || (!msg.includes('credit') && !msg.includes('billing') && !msg.includes('balance'))) {
        throw err;
      }
      console.warn('[NL] Claude failed, falling back to GPT:', msg);
    }
  }

  // Fallback to OpenAI
  if (!openai) throw new Error('沒有可用的 LLM API key');

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? 'gpt-5.4',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ],
    tools: OPENAI_TOOLS,
    tool_choice: 'auto',
  });

  const choice = response.choices[0];
  const toolCalls: LLMToolCall[] = (choice.message.tool_calls ?? []).map(tc => ({
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
  }));

  return {
    toolCalls,
    textReply: choice.message.content,
    provider: 'gpt',
  };
}

const SYSTEM_PROMPT = `你是 Wave Deploy Agent 的 Discord 部署助手。你幫助團隊成員管理 GCP Cloud Run 上的專案部署。

你的能力：
- 列出所有專案
- 查看專案狀態和版本
- 核准或拒絕部署審查
- 發佈或回滾版本
- 切換部署鎖定

規則：
1. 全程用繁體中文回覆
2. 如果使用者的訊息不是部署相關的操作，友善回覆但不要呼叫任何 tool
3. 使用者可能用模糊的方式指定專案（「那個 app」「上次的」），根據上下文判斷
4. 支援一次執行多個操作（「先 approve 再 publish」）
5. 保持簡潔，不要囉嗦`;

// ─── Tool Executor ───

interface ToolResult {
  text: string;
  embed?: EmbedBuilder;
  suggestion?: string;
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'list_projects': {
      const projects = await listProjects();
      return {
        text: `找到 ${projects.length} 個專案`,
        embed: projectListEmbed(projects),
      };
    }

    case 'get_project_status': {
      const project = await findProjectBySlug(input.project as string);
      if (!project) return { text: `找不到專案：${input.project}` };

      let versions;
      let suggestion: string | undefined;
      try {
        const data = await getVersions(project.id);
        versions = data.versions;
        // Smart suggestion: check for pending reviews
        const reviews = await listReviews();
        const pending = reviews.filter(r => !r.decision && r.project_slug === project.slug);
        if (pending.length > 0) {
          suggestion = `💡 這個專案有 ${pending.length} 個待審查的部署，要 approve 嗎？`;
        }
      } catch { /* no versions */ }

      return {
        text: `${project.name} 的狀態`,
        embed: projectStatusEmbed(project, versions),
        suggestion,
      };
    }

    case 'approve_deploy': {
      const project = await findProjectBySlug(input.project as string);
      if (!project) return { text: `找不到專案：${input.project}` };

      const reviews = await listReviews();
      const pending = reviews.find(r => !r.decision && r.project_slug === project.slug);
      if (!pending) return { text: `${project.name} 沒有待審查的部署` };

      await decideReview(pending.id, 'approved', 'discord-bot@punwave.com', input.comments as string);
      return { text: `✅ **${project.name}** 的部署已核准` };
    }

    case 'reject_deploy': {
      const project = await findProjectBySlug(input.project as string);
      if (!project) return { text: `找不到專案：${input.project}` };

      const reviews = await listReviews();
      const pending = reviews.find(r => !r.decision && r.project_slug === project.slug);
      if (!pending) return { text: `${project.name} 沒有待審查的部署` };

      await decideReview(pending.id, 'rejected', 'discord-bot@punwave.com', input.reason as string);
      return { text: `❌ **${project.name}** 的部署已拒絕` };
    }

    case 'publish_version': {
      const project = await findProjectBySlug(input.project as string);
      if (!project) return { text: `找不到專案：${input.project}` };

      const { versions } = await getVersions(project.id);
      const target = versions.find(v => v.version === (input.version as number));
      if (!target) {
        const available = versions.map(v => `v${v.version}`).join(', ');
        return { text: `找不到 v${input.version}。可用版本：${available}` };
      }
      if (!target.revisionName) {
        return { text: `v${input.version} 沒有 Cloud Run revision，無法發佈` };
      }

      const result = await publishVersion(project.id, target.id);
      const emoji = result.isRollback ? '⏪' : '🚀';
      const action = result.isRollback ? '回滾' : '發佈';
      return { text: `${emoji} **${project.name}** 已${action}至 v${result.version}\nRevision: \`${result.revisionName}\`` };
    }

    case 'rollback_version': {
      const project = await findProjectBySlug(input.project as string);
      if (!project) return { text: `找不到專案：${input.project}` };

      const { versions } = await getVersions(project.id);
      let target;
      if (input.version) {
        target = versions.find(v => v.version === (input.version as number));
      } else {
        const publishedIdx = versions.findIndex(v => v.isPublished);
        if (publishedIdx >= 0 && publishedIdx + 1 < versions.length) {
          target = versions[publishedIdx + 1];
        }
      }
      if (!target) return { text: '找不到可回滾的版本' };
      if (!target.revisionName) return { text: `v${target.version} 沒有 Cloud Run revision` };

      const result = await publishVersion(project.id, target.id);
      return { text: `⏪ **${project.name}** 已回滾至 v${result.version}\nRevision: \`${result.revisionName}\`` };
    }

    case 'toggle_deploy_lock': {
      const project = await findProjectBySlug(input.project as string);
      if (!project) return { text: `找不到專案：${input.project}` };

      const result = await toggleDeployLock(project.id);
      const emoji = result.deployLocked ? '🔒' : '🔓';
      return { text: `${emoji} **${project.name}** — ${result.message}` };
    }

    default:
      return { text: `未知操作：${name}` };
  }
}

// ─── Confirmation Flow ───

async function askConfirmation(
  message: Message,
  toolName: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const descriptions: Record<string, string> = {
    publish_version: `🚀 發佈 **${input.project}** 的 v${input.version} 到 production`,
    rollback_version: input.version
      ? `⏪ 回滾 **${input.project}** 到 v${input.version}`
      : `⏪ 回滾 **${input.project}** 到上一版`,
    toggle_deploy_lock: `🔒 切換 **${input.project}** 的部署鎖定`,
  };

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('confirm_yes').setLabel('確認執行').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('confirm_no').setLabel('取消').setStyle(ButtonStyle.Secondary),
  );

  const confirmMsg = await message.reply({
    content: `⚠️ ${descriptions[toolName] ?? toolName}\n\n確定要執行嗎？`,
    components: [row],
  });

  try {
    const interaction = await confirmMsg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i: MessageComponentInteraction) => i.user.id === message.author.id,
      time: 30_000,
    });

    await interaction.update({ components: [] }); // Remove buttons
    return interaction.customId === 'confirm_yes';
  } catch {
    await confirmMsg.edit({ content: '⏰ 操作已過期，請重新輸入。', components: [] });
    return false;
  }
}

// ─── Main Handler ───

export async function handleNaturalLanguage(message: Message): Promise<void> {
  if (!anthropic && !openai) {
    await message.reply('⚠️ 自然語言功能未啟用（缺少 LLM API key）');
    return;
  }

  const userText = message.content
    .replace(/<@!?\d+>/g, '') // Remove @mentions
    .trim();

  if (!userText) return;

  // Show typing indicator
  await message.channel.sendTyping();

  try {
    // Build messages with context
    const context = getContext(message.channelId);
    const msgs = [
      ...context.map(c => ({ role: c.role, content: c.content })),
      { role: 'user' as const, content: userText },
    ];

    const llmResult = await callLLM(msgs);

    // If no tool calls, just reply with text
    if (llmResult.toolCalls.length === 0) {
      const replyText = llmResult.textReply || '🤔 不確定你想做什麼，試試「列出所有專案」或「看 luca 狀態」';
      await message.reply(replyText);
      addContext(message.channelId, userText, replyText);
      return;
    }

    // Execute tool calls (sequentially for multi-step)
    const replies: string[] = [];
    const embeds: EmbedBuilder[] = [];
    const suggestions: string[] = [];

    for (const toolCall of llmResult.toolCalls) {
      // Confirmation for dangerous ops
      if (DANGEROUS_TOOLS.has(toolCall.name)) {
        const confirmed = await askConfirmation(message, toolCall.name, toolCall.input);
        if (!confirmed) {
          replies.push('已取消操作。');
          continue;
        }
      }

      try {
        const result = await executeTool(toolCall.name, toolCall.input);
        replies.push(result.text);
        if (result.embed) embeds.push(result.embed);
        if (result.suggestion) suggestions.push(result.suggestion);
      } catch (err) {
        replies.push(`❌ 執行失敗：${(err as Error).message}`);
      }
    }

    // Build final reply
    const providerTag = llmResult.provider === 'gpt' ? ' `(GPT)`' : '';
    const replyText = replies.join('\n\n') + (suggestions.length > 0 ? '\n\n' + suggestions.join('\n') : '') + providerTag;

    if (embeds.length > 0) {
      await message.reply({ content: replyText, embeds });
    } else {
      await message.reply(replyText);
    }

    addContext(message.channelId, userText, replyText);
  } catch (err) {
    const errMsg = (err as Error).message;
    if (errMsg.includes('rate_limit') || errMsg.includes('429')) {
      await message.reply('⏳ 系統忙碌，請稍後再試');
    } else {
      console.error('[NL] Error:', errMsg);
      await message.reply(`❌ 處理失敗：${errMsg}`);
    }
  }
}

// ─── Morning Digest ───

export function startMorningDigest(
  sendToChannel: (content: string, embeds?: EmbedBuilder[]) => Promise<void>,
): void {
  const CHECK_INTERVAL = 60_000; // Check every minute
  let lastDigestDate = '';

  setInterval(async () => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hour = now.getHours();

    // Already sent today or not the right hour
    if (lastDigestDate === today || hour !== config.digestHour) return;

    lastDigestDate = today;
    console.log('[Digest] Running morning digest...');

    try {
      const [projects, reviews] = await Promise.all([listProjects(), listReviews()]);
      const pendingReviews = reviews.filter(r => !r.decision);

      const items: string[] = [];

      // Pending reviews
      if (pendingReviews.length > 0) {
        items.push(`📋 **${pendingReviews.length} 個待審查部署**`);
        for (const r of pendingReviews.slice(0, 5)) {
          items.push(`  • ${r.project_name} — 等待審查`);
        }
      }

      // Unhealthy or deploying projects
      for (const p of projects) {
        if (p.status === 'deploying' || p.status === 'review_pending') {
          items.push(`⏳ **${p.name}** — ${p.status}`);
        }
      }

      // Deploy locks
      for (const p of projects) {
        const cfg = p.config as Record<string, unknown>;
        if (cfg?.deployLocked) {
          items.push(`🔒 **${p.name}** — 部署已鎖定`);
        }
      }

      if (items.length === 0) {
        items.push('✅ 一切正常，沒有待處理事項');
      }

      const embed = new EmbedBuilder()
        .setTitle('☀️ 早安！今日部署摘要')
        .setDescription(items.join('\n'))
        .setColor(0x3B82F6)
        .setTimestamp()
        .setFooter({ text: 'Wave Deploy Agent • 每日摘要' });

      await sendToChannel('', [embed]);
      console.log('[Digest] Sent morning digest');
    } catch (err) {
      console.error('[Digest] Failed:', (err as Error).message);
    }
  }, CHECK_INTERVAL);
}
