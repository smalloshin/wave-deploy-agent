import type { ChatInputCommandInteraction, AutocompleteInteraction } from 'discord.js';
import { handleList } from './list.js';
import { handleStatus } from './status.js';
import { handleApprove, handleReject } from './approve.js';
import { handlePublish, handleRollback, handleLock } from './publish.js';
import { listProjects } from '../api-client.js';

// Route subcommands to handlers
export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'list':     return handleList(interaction);
    case 'status':   return handleStatus(interaction);
    case 'approve':  return handleApprove(interaction);
    case 'reject':   return handleReject(interaction);
    case 'publish':  return handlePublish(interaction);
    case 'rollback': return handleRollback(interaction);
    case 'lock':     return handleLock(interaction);
    default:
      await interaction.reply(`❌ 未知指令: \`${sub}\``);
  }
}

// Autocomplete for project name/slug
let projectCache: { slug: string; name: string }[] = [];
let projectCacheTime = 0;
const CACHE_TTL = 30_000; // 30 seconds

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();

  // Refresh cache if stale
  if (Date.now() - projectCacheTime > CACHE_TTL) {
    try {
      const projects = await listProjects();
      projectCache = projects.map(p => ({ slug: p.slug, name: p.name }));
      projectCacheTime = Date.now();
    } catch {
      // Use stale cache on error
    }
  }

  const filtered = projectCache
    .filter(p =>
      p.slug.toLowerCase().includes(focused.toLowerCase()) ||
      p.name.toLowerCase().includes(focused.toLowerCase())
    )
    .slice(0, 25);

  await interaction.respond(
    filtered.map(p => ({ name: `${p.name} (${p.slug})`, value: p.slug }))
  );
}
