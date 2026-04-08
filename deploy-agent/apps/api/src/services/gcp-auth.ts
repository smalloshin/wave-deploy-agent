// GCP Auth helper — gets access token from metadata server (Cloud Run)
// or from ADC (local dev via gcloud auth application-default login)

const METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;
const identityTokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  // Try metadata server first (Cloud Run / GCE / GKE)
  try {
    const res = await fetch(`${METADATA_BASE}/token`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as TokenResponse;
      cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      return cachedToken.token;
    }
  } catch {
    // Not on GCP, fall through to ADC
  }

  // Fallback: Application Default Credentials via gcloud CLI
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const { stdout } = await exec('gcloud', ['auth', 'print-access-token'], { timeout: 10_000 });
    const token = stdout.trim();
    cachedToken = { token, expiresAt: Date.now() + 3500_000 };
    return token;
  } catch {
    throw new Error('Cannot obtain GCP access token. Ensure the service runs on GCP or has ADC configured.');
  }
}

// Get identity token for invoking other Cloud Run services
export async function getIdentityToken(audience: string): Promise<string> {
  const cached = identityTokenCache.get(audience);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  // Extract audience (scheme + host) from URL
  const aud = new URL(audience).origin;

  try {
    const res = await fetch(
      `${METADATA_BASE}/identity?audience=${encodeURIComponent(aud)}`,
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) }
    );
    if (res.ok) {
      const token = await res.text();
      identityTokenCache.set(audience, { token, expiresAt: Date.now() + 3500_000 });
      return token;
    }
  } catch {
    // Fall through
  }

  throw new Error(`Cannot obtain identity token for ${aud}`);
}

export interface GcpFetchOptions extends RequestInit {
  useIdentityToken?: boolean;
}

// Helper for authenticated GCP API calls
export async function gcpFetch(
  url: string,
  options: GcpFetchOptions = {}
): Promise<Response> {
  const { useIdentityToken, ...fetchOptions } = options;
  const token = useIdentityToken
    ? await getIdentityToken(url)
    : await getAccessToken();
  return fetch(url, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  });
}
