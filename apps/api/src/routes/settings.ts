import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/index';

// Settings are stored in a single-row `settings` table.
// If the table doesn't exist, we gracefully return defaults.

const settingsSchema = z.object({
  gcpProject: z.string().optional(),
  gcpRegion: z.string().optional(),
  artifactRegistry: z.string().optional(),
  baseDomain: z.string().optional(),
  cloudflareToken: z.string().optional(),
  cloudflareZoneId: z.string().optional(),
  cloudflareZoneName: z.string().optional(),
  slackWebhookUrl: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  githubToken: z.string().optional(),
});

type Settings = z.infer<typeof settingsSchema>;

const DEFAULTS: Settings = {
  gcpProject: process.env.GCP_PROJECT ?? '',
  gcpRegion: process.env.GCP_REGION ?? 'asia-east1',
  artifactRegistry: '',
  baseDomain: process.env.CLOUDFLARE_ZONE_NAME ?? '',
  cloudflareToken: process.env.CLOUDFLARE_TOKEN ? '••••••••' : '',
  cloudflareZoneId: process.env.CLOUDFLARE_ZONE_ID ?? '',
  cloudflareZoneName: process.env.CLOUDFLARE_ZONE_NAME ?? '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ? '••••••••' : '',
  githubToken: process.env.GITHUB_TOKEN ? '••••••••' : '',
};

async function ensureSettingsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Insert default row if empty
  await query(`
    INSERT INTO settings (id, data) VALUES (1, $1)
    ON CONFLICT (id) DO NOTHING
  `, [JSON.stringify({})]);
}

export async function settingsRoutes(app: FastifyInstance) {
  // Get settings
  app.get('/api/settings', async () => {
    try {
      await ensureSettingsTable();
      const result = await query('SELECT data FROM settings WHERE id = 1');
      const stored = result.rows[0]?.data ?? {};
      const data = typeof stored === 'string' ? JSON.parse(stored) : stored;

      // Merge stored with defaults (stored takes priority, but mask secrets)
      const settings: Settings = { ...DEFAULTS };
      for (const [key, value] of Object.entries(data as Record<string, string>)) {
        if (value && key in settings) {
          // Mask secret fields when returning
          if (key.includes('Token') || key.includes('Key') || key.includes('apiKey')) {
            (settings as Record<string, string>)[key] = value ? '••••••••' : '';
          } else {
            (settings as Record<string, string>)[key] = value;
          }
        }
      }

      return { settings };
    } catch {
      // DB not available, return env defaults
      return { settings: DEFAULTS };
    }
  });

  // Save settings
  app.put('/api/settings', async (request) => {
    const body = settingsSchema.parse(request.body);

    try {
      await ensureSettingsTable();

      // Read existing settings so we don't overwrite secrets with masked values
      const existing = await query('SELECT data FROM settings WHERE id = 1');
      const existingData = existing.rows[0]?.data ?? {};
      const parsed = typeof existingData === 'string' ? JSON.parse(existingData) : existingData;

      // Merge: if the new value is masked (••••••••), keep the old value
      const merged: Record<string, string> = { ...parsed as Record<string, string> };
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined || value === '') continue;
        if (value === '••••••••') continue; // Don't overwrite with mask
        merged[key] = value;
      }

      await query(
        `UPDATE settings SET data = $1, updated_at = NOW() WHERE id = 1`,
        [JSON.stringify(merged)]
      );

      return { success: true, message: 'Settings saved' };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  });
}
