// Deployed Source Capture
// ─────────────────────────
// 在 deploy 成功之後把「實際部署的 code」（post-fix + generated Dockerfile）
// 存到 gs://wave-deploy-agent-deployed/{slug}/v{version}.tgz，
// 讓使用者可以下載回去從安全基準繼續開發。
//
// 資料來源優先順序：
//   1. projectDir（本機檔案，若存在）— 有 pipeline-worker 套用過的修補 + 生成的 Dockerfile
//   2. 複製 gcsSourceUri 指向的物件 — fallback，內容是原始上傳版本
//
// Bucket 有 365 天 lifecycle；超過期限自動刪除。

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcpFetch } from './gcp-auth';

const execFileAsync = promisify(execFile);

const DEPLOYED_BUCKET = process.env.DEPLOYED_SOURCES_BUCKET || 'wave-deploy-agent-deployed';

export interface CaptureResult {
  gcsUri: string;
  sourceBytes: number;
  capturedFrom: 'projectDir' | 'gcsSourceUri';
}

export interface CaptureMetadata {
  projectName: string;
  projectSlug: string;
  version: number;
  cloudRunUrl: string | null;
  customDomain: string | null;
  imageUri: string | null;
  revisionName: string | null;
  deployedAt: Date;
  autoFixesApplied?: number;
  findingsSummary?: string;
}

/**
 * Capture the deployed source (post-fix projectDir or GCS object) and upload
 * to the long-term deployed-sources bucket. Also writes an inline DEPLOYMENT.md
 * into the tarball so users have context when they download.
 */
export async function captureDeployedSource(
  metadata: CaptureMetadata,
  projectDir: string | undefined,
  gcsSourceUri: string | undefined,
): Promise<CaptureResult> {
  if (!projectDir && !gcsSourceUri) {
    throw new Error('captureDeployedSource: need either projectDir or gcsSourceUri');
  }

  const objectName = `${metadata.projectSlug}/v${metadata.version}.tgz`;
  const stagingDir = join(tmpdir(), `deploy-capture-${metadata.projectSlug}-${metadata.version}-${Date.now()}`);
  const tarballPath = `${stagingDir}.tgz`;

  let capturedFrom: CaptureResult['capturedFrom'];

  try {
    await execFileAsync('mkdir', ['-p', stagingDir], { timeout: 5_000 });

    if (projectDir && existsSync(projectDir)) {
      // Preferred: copy local projectDir (has AI fixes + generated Dockerfile)
      capturedFrom = 'projectDir';
      await execFileAsync('cp', ['-R', `${projectDir}/.`, stagingDir], { timeout: 60_000 });
    } else if (gcsSourceUri && gcsSourceUri.startsWith('gs://')) {
      // Fallback: extract the GCS source (original upload, pre-fix)
      capturedFrom = 'gcsSourceUri';
      const withoutPrefix = gcsSourceUri.slice(5);
      const slashIdx = withoutPrefix.indexOf('/');
      const bucket = withoutPrefix.slice(0, slashIdx);
      const object = withoutPrefix.slice(slashIdx + 1);
      const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;
      const resp = await gcpFetch(downloadUrl);
      if (!resp.ok) {
        throw new Error(`Failed to download source from ${gcsSourceUri}: ${resp.status}`);
      }
      const { writeFileSync } = await import('node:fs');
      const srcTgz = Buffer.from(await resp.arrayBuffer());
      const downloadPath = `${stagingDir}.src.tgz`;
      writeFileSync(downloadPath, srcTgz);
      await execFileAsync('tar', ['xzf', downloadPath, '-C', stagingDir], { timeout: 60_000 });
      try { await execFileAsync('rm', ['-f', downloadPath], { timeout: 5_000 }); } catch { /* ignore */ }
    } else {
      throw new Error('captureDeployedSource: projectDir missing and gcsSourceUri not usable');
    }

    // Write DEPLOYMENT.md alongside (doesn't overwrite if user already has one)
    const deploymentMdPath = join(stagingDir, 'DEPLOYMENT.md');
    if (!existsSync(deploymentMdPath)) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(deploymentMdPath, buildDeploymentMarkdown(metadata, capturedFrom), 'utf8');
    }

    // Tar it up
    await execFileAsync('tar', ['-czf', tarballPath, '-C', stagingDir, '.'], { timeout: 120_000 });

    // Upload to deployed bucket
    const { readFileSync, unlinkSync, statSync } = await import('node:fs');
    const tarball = readFileSync(tarballPath);
    const sourceBytes = statSync(tarballPath).size;

    const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${DEPLOYED_BUCKET}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    const res = await gcpFetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: tarball,
    });

    // Cleanup local artifacts
    try { unlinkSync(tarballPath); } catch { /* ignore */ }
    try { await execFileAsync('rm', ['-rf', stagingDir], { timeout: 15_000 }); } catch { /* ignore */ }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Deployed source upload failed (${res.status}): ${err}`);
    }

    const gcsUri = `gs://${DEPLOYED_BUCKET}/${objectName}`;
    console.log(`[DeployCapture] Stored ${gcsUri} (${sourceBytes} bytes, from ${capturedFrom})`);
    return { gcsUri, sourceBytes, capturedFrom };
  } catch (err) {
    // Always try to clean up, even on error
    try { await execFileAsync('rm', ['-rf', stagingDir, tarballPath], { timeout: 5_000 }); } catch { /* ignore */ }
    throw err;
  }
}

function buildDeploymentMarkdown(meta: CaptureMetadata, capturedFrom: CaptureResult['capturedFrom']): string {
  const deployedAt = meta.deployedAt.toISOString();
  const url = meta.customDomain ? `https://${meta.customDomain}` : meta.cloudRunUrl;
  const sourceNote = capturedFrom === 'projectDir'
    ? '本 tarball 是 wave-deploy-agent 在掃描與 AI 自動修補後實際部署的版本，推薦從這裡繼續開發以避免重新引入已修過的漏洞。'
    : '本 tarball 是原始上傳版本（deploy 時本機修補版已遺失，fallback 到 GCS 原檔）。若你需要 AI 修過的版本，請重新觸發部署並在部署成功後立刻下載。';

  return [
    `# ${meta.projectName} — 部署快照 v${meta.version}`,
    '',
    sourceNote,
    '',
    '## 部署資訊',
    '',
    `- **部署時間**：${deployedAt}`,
    `- **Cloud Run URL**：${url ?? '尚未取得'}`,
    meta.customDomain ? `- **自訂網域**：https://${meta.customDomain}` : '',
    meta.imageUri ? `- **Docker Image**：${meta.imageUri}` : '',
    meta.revisionName ? `- **Cloud Run Revision**：${meta.revisionName}` : '',
    meta.autoFixesApplied !== undefined ? `- **AI 套用修補數**：${meta.autoFixesApplied}` : '',
    meta.findingsSummary ? `- **掃描摘要**：${meta.findingsSummary}` : '',
    '',
    '## 本地執行',
    '',
    '```bash',
    '# 解壓後在當前目錄',
    'docker build -t my-app .',
    'docker run --rm -p 8080:8080 --env-file .env my-app',
    '```',
    '',
    '## 重新部署',
    '',
    '```bash',
    '# 方式 1：打包後透過 dashboard 升版',
    'tar -czf /tmp/my-app.tgz -C . .',
    '# 在 dashboard 點 "升版" 上傳',
    '',
    '# 方式 2：推到 Git 再提 Git URL 部署',
    'git init && git add . && git commit -m "baseline from wave-deploy-agent v' + meta.version + '"',
    '```',
    '',
    '## 注意事項',
    '',
    '1. `DEPLOYMENT.md` 是自動產生，你可以覆寫或刪除',
    '2. `.env` 檔案不在 tarball 裡（機密資料由 Cloud Run 的環境變數 / Secret Manager 注入）',
    '3. 下次從這份 code 升版時，wave-deploy-agent 會再次掃描並套用新的修補',
    '',
    '---',
    '',
    '_由 wave-deploy-agent 自動產生_',
  ].filter(Boolean).join('\n');
}

/**
 * Generate a V4 signed URL for downloading a deployed-source tarball.
 * 15-minute expiry by default.
 */
export async function generateDownloadSignedUrl(
  gcsUri: string,
  expiresInMinutes = 15,
): Promise<string> {
  if (!gcsUri.startsWith('gs://')) {
    throw new Error(`Invalid GCS URI: ${gcsUri}`);
  }
  const withoutPrefix = gcsUri.slice(5);
  const slashIdx = withoutPrefix.indexOf('/');
  const bucket = withoutPrefix.slice(0, slashIdx);
  const object = withoutPrefix.slice(slashIdx + 1);

  // Use gcloud to sign URL (works when running with Cloud Run SA that has
  // iam.serviceAccountTokenCreator on itself, which we do).
  // Fall back to public-ish URL with access token if sign fails.
  try {
    const { stdout } = await execFileAsync(
      'gcloud',
      [
        'storage',
        'sign-url',
        `gs://${bucket}/${object}`,
        '--duration', `${expiresInMinutes}m`,
        '--format=value(signed_url)',
        '--project', process.env.GCP_PROJECT || 'wave-deploy-agent',
      ],
      { timeout: 10_000 },
    );
    const url = stdout.trim();
    if (url.startsWith('http')) return url;
    throw new Error('gcloud sign-url produced no URL');
  } catch (err) {
    // gcloud isn't available inside Cloud Run — use SignBlob via IAM Credentials API
    return signUrlWithIamCredentials(bucket, object, expiresInMinutes);
  }
}

// V4 signed URL via IAM Credentials signBlob API.
// This works on Cloud Run where the SA has iam.serviceAccountTokenCreator on itself.
async function signUrlWithIamCredentials(
  bucket: string,
  object: string,
  expiresInMinutes: number,
): Promise<string> {
  const saEmail = process.env.DEPLOY_AGENT_SA_EMAIL
    || `deploy-agent@${process.env.GCP_PROJECT || 'wave-deploy-agent'}.iam.gserviceaccount.com`;
  const expiresInSeconds = expiresInMinutes * 60;

  // V4 signing spec: https://cloud.google.com/storage/docs/access-control/signed-urls-v4
  const now = new Date();
  const requestTimestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const datestamp = requestTimestamp.slice(0, 8);
  const credentialScope = `${datestamp}/auto/storage/goog4_request`;
  const credential = `${saEmail}/${credentialScope}`;

  const host = 'storage.googleapis.com';
  const canonicalUri = `/${bucket}/${object.split('/').map(encodeURIComponent).join('/')}`;

  const signedHeaders = 'host';
  const canonicalHeaders = `host:${host}\n`;

  const queryParams: Record<string, string> = {
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': credential,
    'X-Goog-Date': requestTimestamp,
    'X-Goog-Expires': String(expiresInSeconds),
    'X-Goog-SignedHeaders': signedHeaders,
  };
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const { createHash } = await import('node:crypto');
  const canonicalRequestHash = createHash('sha256').update(canonicalRequest).digest('hex');

  const stringToSign = [
    'GOOG4-RSA-SHA256',
    requestTimestamp,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  // Sign via IAM Credentials API
  const signBlobUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:signBlob`;
  const signRes = await gcpFetch(signBlobUrl, {
    method: 'POST',
    body: JSON.stringify({
      payload: Buffer.from(stringToSign, 'utf8').toString('base64'),
    }),
  });
  if (!signRes.ok) {
    const errText = await signRes.text();
    throw new Error(`IAM signBlob failed (${signRes.status}): ${errText}`);
  }
  const signResult = await signRes.json() as { signedBlob: string };
  const signatureHex = Buffer.from(signResult.signedBlob, 'base64').toString('hex');

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Goog-Signature=${signatureHex}`;
}
