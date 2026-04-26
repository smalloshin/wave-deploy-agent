/**
 * Discord NL audit-trail API.
 *
 * Two endpoints, paired writer pattern:
 *   POST /api/discord-audit         — pre-call insert (status='pending'),
 *                                     returns the new row id
 *   PATCH /api/discord-audit/:id    — post-call update (status =
 *                                     'success' | 'error' | 'denied' |
 *                                     'cancelled', plus result_text)
 *
 * The bot calls these around every tool execution. If the POST fails
 * the bot logs a warning and proceeds — audit must NEVER break the NL
 * flow (a missing audit row is recoverable; a broken bot blocks
 * operators).
 *
 * Defense-in-depth: even though the bot sanitizes locally before
 * sending, this route runs the same sanitizer on the way in. If the
 * bot ever regresses, the API still strips secrets.
 *
 * RBAC: Bearer auth required (request.auth.user). In permissive mode
 * anonymous is allowed but audited as anonymous_request — same shape as
 * other write endpoints. The route is registered in
 * middleware/auth.ts ROUTE_PERMISSIONS as 'projects:write' (the bot's
 * existing API key has this).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/index.js';
import {
  sanitizeToolInput,
  sanitizeResultText,
} from '../services/discord-audit-mapper.js';

const PendingSchema = z.object({
  discordUserId: z.string().min(1).max(64),
  channelId: z.string().min(1).max(64),
  messageId: z.string().max(64).optional(),
  toolName: z.string().min(1).max(64),
  toolInput: z.record(z.unknown()).default({}),
  intentText: z.string().max(2000).optional(),
  llmProvider: z.enum(['claude', 'gpt']).optional(),
  status: z.literal('pending'),
});

const ResultSchema = z.object({
  status: z.enum(['success', 'error', 'denied', 'cancelled']),
  resultText: z.string().optional(),
});

const INTENT_TRUNCATE_LEN = 500;

export async function discordAuditRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/discord-audit — create a 'pending' audit row before tool exec.
  app.post('/api/discord-audit', async (request, reply) => {
    const parsed = PendingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    // Defense-in-depth: re-sanitize even if the bot already did.
    const safeInput = sanitizeToolInput(data.toolInput);
    const safeIntent = data.intentText
      ? data.intentText.slice(0, INTENT_TRUNCATE_LEN)
      : null;

    const result = await pool.query<{ id: string }>(
      `INSERT INTO discord_audit
         (discord_user_id, channel_id, message_id, tool_name,
          tool_input, intent_text, status, llm_provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        data.discordUserId,
        data.channelId,
        data.messageId ?? null,
        data.toolName,
        JSON.stringify(safeInput),
        safeIntent,
        data.status,
        data.llmProvider ?? null,
      ],
    );
    return { id: Number(result.rows[0].id) };
  });

  // PATCH /api/discord-audit/:id — stamp result after tool exec.
  app.patch<{ Params: { id: string } }>(
    '/api/discord-audit/:id',
    async (request, reply) => {
      const parsed = ResultSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const { status, resultText } = parsed.data;
      const safeResult = resultText ? sanitizeResultText(resultText) : null;

      const idNum = Number(request.params.id);
      if (!Number.isInteger(idNum) || idNum <= 0) {
        return reply.code(400).send({ error: 'Invalid id' });
      }

      const result = await pool.query(
        `UPDATE discord_audit
            SET status = $1, result_text = $2, updated_at = NOW()
          WHERE id = $3`,
        [status, safeResult, idNum],
      );

      if ((result.rowCount ?? 0) === 0) {
        return reply.code(404).send({ error: 'Audit row not found' });
      }
      return { ok: true };
    },
  );
}
