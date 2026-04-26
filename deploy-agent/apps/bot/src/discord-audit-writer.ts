// Discord NL audit-trail writer (bot side).
//
// Pairs with apps/api/src/routes/discord-audit.ts. Posts a 'pending'
// row BEFORE the tool runs, then PATCHes the result AFTER. If either
// HTTP call fails, swallow with console.warn — audit must never break
// the NL flow (a missing audit row is recoverable; a broken bot blocks
// operators).
//
// Usage from nl-handler.ts:
//   const auditId = await logDiscordAuditPending({...});
//   try {
//     const result = await executeTool(...);
//     await logDiscordAuditResult(auditId, 'success', result.text);
//   } catch (err) {
//     await logDiscordAuditResult(auditId, 'error', err.message);
//   }

import { config } from './config.js';

const API = config.apiBaseUrl;

function authHeaders(): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

export interface AuditPendingOpts {
  discordUserId: string;
  channelId: string;
  messageId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  intentText?: string;
  llmProvider?: 'claude' | 'gpt';
}

export type AuditStatus = 'success' | 'error' | 'denied' | 'cancelled';

/**
 * POST /api/discord-audit with status='pending'. Returns the new row id,
 * or null if the API call failed for any reason.
 *
 * Errors are swallowed (warned only): the NL handler must continue even
 * if audit write fails, because a broken audit table shouldn't block
 * operator work. The returning `null` lets the caller skip the result
 * PATCH downstream.
 */
export async function logDiscordAuditPending(
  opts: AuditPendingOpts,
): Promise<number | null> {
  try {
    const res = await fetch(`${API}/api/discord-audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        discordUserId: opts.discordUserId,
        channelId: opts.channelId,
        messageId: opts.messageId,
        toolName: opts.toolName,
        toolInput: opts.toolInput,
        intentText: opts.intentText,
        llmProvider: opts.llmProvider,
        status: 'pending',
      }),
    });
    if (!res.ok) {
      console.warn(`[discord-audit] POST failed: ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }
    const json = (await res.json()) as { id?: number };
    return typeof json.id === 'number' ? json.id : null;
  } catch (err) {
    console.warn('[discord-audit] POST error:', (err as Error).message);
    return null;
  }
}

/**
 * PATCH /api/discord-audit/:id with the final status + result_text.
 * If id is null (pending POST failed), no-op.
 *
 * Errors are swallowed (warned only) — same rationale as logDiscordAuditPending.
 */
export async function logDiscordAuditResult(
  id: number | null,
  status: AuditStatus,
  resultText?: string,
): Promise<void> {
  if (id === null) return;
  try {
    const res = await fetch(`${API}/api/discord-audit/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ status, resultText }),
    });
    if (!res.ok) {
      console.warn(`[discord-audit] PATCH ${id} failed: ${res.status}`);
    }
  } catch (err) {
    console.warn('[discord-audit] PATCH error:', (err as Error).message);
  }
}
