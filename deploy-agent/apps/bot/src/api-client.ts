// API client — typed wrapper for Deploy Agent API calls
// Uses native fetch (Node 22), zero dependencies

import { config } from './config.js';
import { buildAuthHeaders } from './auth-headers.js';

const API = config.apiBaseUrl;

// ─── Types ───

export interface Project {
  id: string;
  name: string;
  slug: string;
  status: string;
  sourceType: string;
  detectedLanguage: string | null;
  detectedFramework: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DeployVersion {
  id: string;
  version: number;
  cloudRunService: string | null;
  cloudRunUrl: string | null;
  customDomain: string | null;
  imageUri: string | null;
  revisionName: string | null;
  previewUrl: string | null;
  healthStatus: string;
  isPublished: boolean;
  publishedAt: string | null;
  deployedAt: string | null;
  createdAt: string;
}

export interface Review {
  id: string;
  scan_report_id: string;
  reviewer_email: string | null;
  decision: string | null;
  comments: string | null;
  project_id: string;
  project_name: string;
  project_slug: string;
  created_at: string;
}

// ─── API Calls ───

function authHeaders(): Record<string, string> {
  // Round 37: pure logic lives in ./auth-headers.ts so it can be tested
  // without dragging `config` (which exits on missing required env).
  return buildAuthHeaders(config.apiKey);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const raw = await res.text();
    let msg = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string; error?: string };
      msg = parsed.message ?? parsed.error ?? raw;
    } catch { /* not JSON, use raw */ }
    throw new Error(`API ${path}: ${res.status} — ${msg}`);
  }
  return res.json() as Promise<T>;
}

async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const raw = await res.text();
    let msg = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string; error?: string };
      msg = parsed.message ?? parsed.error ?? raw;
    } catch { /* not JSON, use raw */ }
    throw new Error(`API ${path}: ${res.status} — ${msg}`);
  }
  // Some DELETE endpoints return 204 No Content; handle that gracefully.
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

export async function deleteProjectApi(projectId: string): Promise<{ ok?: boolean }> {
  return apiDelete<{ ok?: boolean }>(`/api/projects/${projectId}`);
}

// Projects
export async function listProjects(): Promise<Project[]> {
  const data = await get<{ projects: Project[] }>('/api/projects');
  return data.projects;
}

export async function getProject(id: string): Promise<Project> {
  const data = await get<{ project: Project }>(`/api/projects/${id}`);
  return data.project;
}

export async function findProjectBySlug(slug: string): Promise<Project | null> {
  const projects = await listProjects();
  return projects.find(p => p.slug === slug || p.name === slug) ?? null;
}

// Versions
export async function getVersions(projectId: string): Promise<{
  versions: DeployVersion[];
  publishedDeploymentId: string | null;
  deployLocked: boolean;
}> {
  return get(`/api/projects/${projectId}/versions`);
}

// Publish / Rollback
export async function publishVersion(projectId: string, deployId: string): Promise<{
  published: boolean;
  version: number;
  revisionName: string;
  isRollback: boolean;
  message: string;
}> {
  return post(`/api/projects/${projectId}/versions/${deployId}/publish`);
}

// Deploy Lock
export async function toggleDeployLock(projectId: string, locked?: boolean): Promise<{
  deployLocked: boolean;
  message: string;
}> {
  return post(`/api/projects/${projectId}/deploy-lock`, locked !== undefined ? { locked } : {});
}

// Reviews
export async function listReviews(): Promise<Review[]> {
  const data = await get<{ reviews: Review[] }>('/api/reviews');
  return data.reviews;
}

export async function decideReview(reviewId: string, decision: 'approved' | 'rejected', email: string, comments?: string): Promise<unknown> {
  return post(`/api/reviews/${reviewId}/decide`, {
    decision,
    reviewerEmail: email,
    comments: comments ?? `${decision} via Discord`,
  });
}

// Scan report
export async function getScanReport(projectId: string): Promise<unknown> {
  return get(`/api/projects/${projectId}/scan-report`);
}
