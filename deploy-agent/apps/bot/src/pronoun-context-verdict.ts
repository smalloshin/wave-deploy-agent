// Pronoun-context fetcher.
//
// Why this exists:
//   The in-memory channelMemory in nl-handler is per-channel and gets
//   wiped on bot restart. Operators expect "publish it" to work even
//   the bot was restarted between their two messages. This module
//   pulls recent operator messages from Discord channel history so
//   the LLM has enough context to resolve "it"/"that"/"上次的".
//
//   Critical: only messages from the CURRENT operator are returned.
//   Other operators' messages are not part of the pronoun antecedent
//   pool — that would conflate intents across users. (Their messages
//   may still appear in <untrusted_channel_history> if you choose to
//   include them, but for pronoun resolution we constrain to the
//   speaker.)
//
// Pattern: this is NOT a pure verdict (it does I/O — Discord API).
// It's named "*-verdict" for naming consistency only; the file
// boundary is what matters (isolated, testable, swappable).
//
// The function can return `context-empty` when the channel has no
// recent messages from this operator within the maxAgeMs window —
// the caller should still pass an empty array to wrapUntrustedHistory
// without erroring.

import type { TextChannel } from 'discord.js';
import type { ContextEntry } from './untrusted-history-verdict.js';

export interface PronounContextOpts {
  channel: TextChannel;
  operatorId: string;
  nowMs: number;
  /** Max number of operator messages to return. Default 10. */
  maxMessages: number;
  /** Max age in ms — older messages are dropped. Default 30 min. */
  maxAgeMs: number;
}

export interface PronounContextResult {
  kind: 'context-found' | 'context-empty';
  entries: ContextEntry[];
}

/**
 * Fetch up to `maxMessages` recent messages from `operatorId` in
 * `channel`, dropping anything older than `maxAgeMs`. Returns entries
 * in CHRONOLOGICAL order (oldest first) so the LLM reads them as a
 * conversation transcript.
 *
 * Network errors are caught — return context-empty rather than
 * throwing. Pronoun context is a nice-to-have; failing it shouldn't
 * break the NL flow.
 */
export async function fetchPronounContext(
  opts: PronounContextOpts,
): Promise<PronounContextResult> {
  try {
    // Discord API caps at 100 per fetch; 50 is plenty for context purposes.
    const fetched = await opts.channel.messages.fetch({ limit: 50 });

    const eligible: ContextEntry[] = [];
    for (const msg of fetched.values()) {
      if (msg.author.id !== opts.operatorId) continue;
      if (opts.nowMs - msg.createdTimestamp >= opts.maxAgeMs) continue;
      eligible.push({
        role: 'user',
        content: msg.content,
        authorId: msg.author.id,
        timestamp: msg.createdAt.toISOString(),
      });
    }

    // Discord returns newest first; reverse to chronological for the LLM.
    eligible.reverse();

    // Take the most recent `maxMessages` after reversing → tail of array.
    const trimmed =
      eligible.length > opts.maxMessages
        ? eligible.slice(eligible.length - opts.maxMessages)
        : eligible;

    return {
      kind: trimmed.length > 0 ? 'context-found' : 'context-empty',
      entries: trimmed,
    };
  } catch (err) {
    console.warn('[pronoun-context] fetch failed:', (err as Error).message);
    return { kind: 'context-empty', entries: [] };
  }
}

/**
 * Merge in-memory context with channel-history pronoun context. The
 * in-memory entries take precedence on duplicates (same content + role)
 * because they're the canonical conversation thread; channel history
 * is fallback.
 *
 * Both inputs are CHRONOLOGICAL (oldest first); output is
 * chronological too. Dedupe by `${role}:${content}` key.
 */
export function mergeContextEntries(
  fromHistory: ContextEntry[],
  fromMemory: ContextEntry[],
): ContextEntry[] {
  const seen = new Set<string>();
  const out: ContextEntry[] = [];

  // History first (older), then memory (newer + canonical).
  // Memory entries with same key win because we add memory LAST and
  // dedupe on first-seen → invert: walk memory first to claim keys,
  // then walk history skipping claimed keys, then put memory at the
  // end in chronological order.
  for (const e of fromMemory) {
    seen.add(`${e.role}:${e.content}`);
  }
  for (const e of fromHistory) {
    const key = `${e.role}:${e.content}`;
    if (seen.has(key)) continue;
    out.push(e);
  }
  out.push(...fromMemory);
  return out;
}
