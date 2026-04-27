import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/index';
import {
  submitReview,
  getProject,
  transitionProject,
} from '../services/orchestrator';
import { runDeployPipeline } from '../services/deploy-worker';
import {
  parseReviewsListQuery,
  buildReviewsListSql,
  buildReviewsCountSql,
} from '../services/reviews-query';
import { scopeForRequest, type AuthMode } from '../services/projects-query';

const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  // reviewerEmail is optional — falls back to authenticated user's email when absent
  reviewerEmail: z.string().email().optional(),
  comments: z.string().optional(),
});

// Pagination-related query keys. Presence of any one triggers the paged
// response envelope `{ reviews, total, limit, offset }`. Absence keeps
// the legacy `{ reviews }` envelope so existing bot/dashboard callers
// using `?status=pending` keep working unchanged.
const PAGED_KEYS = new Set(['paginate', 'limit', 'offset', 'decision', 'since', 'until']);

export async function reviewRoutes(app: FastifyInstance) {
  // List reviews (filtered + optionally paged)
  app.get('/api/reviews', async (request, reply) => {
    const rawQuery = (request.query ?? {}) as Record<string, unknown>;
    const wantsPaged = Object.keys(rawQuery).some((k) => PAGED_KEYS.has(k));

    const verdict = parseReviewsListQuery(rawQuery);
    if (verdict.kind === 'invalid') {
      return reply.status(400).send({ error: verdict.reason });
    }
    const q = verdict.query;

    // R33 — RBAC scope filter at SQL layer (closes IDOR on GET /api/reviews).
    // Admin → see all; non-admin → only reviews on projects they own;
    // anonymous + permissive → all (legacy compat); anonymous + enforced → denied.
    const authMode = (process.env.AUTH_MODE === 'enforced' ? 'enforced' : 'permissive') as AuthMode;
    const scope = scopeForRequest(request.auth, authMode);

    if (!wantsPaged) {
      // Legacy envelope: bot + existing dashboards rely on this shape.
      // Use the parsed status (default 'pending') but skip pagination.
      const list = buildReviewsListSql({ ...q, limit: 200, offset: 0 }, scope);
      const result = await query(list.text, list.values);
      return { reviews: result.rows };
    }

    // Paged envelope
    const list = buildReviewsListSql(q, scope);
    const count = buildReviewsCountSql(q, scope);
    const [listResult, countResult] = await Promise.all([
      query(list.text, list.values),
      query(count.text, count.values),
    ]);
    return {
      reviews: listResult.rows,
      total: countResult.rows[0]?.total ?? 0,
      limit: q.limit,
      offset: q.offset,
    };
  });

  // Get single review
  app.get<{ Params: { id: string } }>('/api/reviews/:id', async (request, reply) => {
    const result = await query(
      `SELECT r.*, sr.project_id, sr.semgrep_findings, sr.trivy_findings,
              sr.llm_analysis, sr.auto_fixes, sr.threat_summary, sr.cost_estimate,
              p.name as project_name, p.slug as project_slug
       FROM reviews r
       JOIN scan_reports sr ON r.scan_report_id = sr.id
       JOIN projects p ON sr.project_id = p.id
       WHERE r.id = $1`,
      [request.params.id]
    );

    if (result.rows.length === 0) return reply.status(404).send({ error: 'Review not found' });
    return { review: result.rows[0] };
  });

  // Submit review decision
  app.post<{ Params: { id: string } }>('/api/reviews/:id/decide', async (request, reply) => {
    const parsed = reviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid input',
        details: parsed.error.flatten(),
      });
    }
    const body = parsed.data;

    // Resolve reviewer email: prefer authenticated user, fall back to body
    const reviewerEmail = request.auth?.user?.email ?? body.reviewerEmail;
    if (!reviewerEmail) {
      return reply.status(400).send({ error: 'Reviewer email is required (log in or pass reviewerEmail)' });
    }

    // Get the review and associated project
    const reviewResult = await query(
      `SELECT r.*, sr.project_id FROM reviews r
       JOIN scan_reports sr ON r.scan_report_id = sr.id
       WHERE r.id = $1`,
      [request.params.id]
    );

    if (reviewResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Review not found' });
    }

    const reviewRow = reviewResult.rows[0];
    if (reviewRow.decision) {
      return reply.status(400).send({ error: 'Review already decided' });
    }

    const review = await submitReview(
      request.params.id,
      body.decision,
      reviewerEmail,
      body.comments
    );

    // Transition project state
    const projectId = reviewRow.project_id as string;
    if (body.decision === 'approved') {
      await transitionProject(projectId, 'approved', reviewerEmail, {
        reviewId: request.params.id,
        comments: body.comments,
      });

      // Trigger deploy pipeline asynchronously
      runDeployPipeline(projectId, request.params.id).catch((err) => {
        console.error(`[Deploy] Async dispatch failed for ${projectId}:`, (err as Error).message);
      });
    } else {
      await transitionProject(projectId, 'rejected', reviewerEmail, {
        reviewId: request.params.id,
        reason: body.comments,
      });
    }

    return { review };
  });
}
