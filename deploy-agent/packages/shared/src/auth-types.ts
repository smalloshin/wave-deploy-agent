// Auth / RBAC shared types

export type Permission =
  | 'projects:read' | 'projects:write' | 'projects:deploy' | 'projects:delete'
  | 'reviews:read' | 'reviews:decide'
  | 'deploys:read'
  | 'versions:read' | 'versions:publish'
  | 'infra:read' | 'infra:admin'
  | 'settings:read' | 'settings:write'
  | 'users:manage'
  | 'mcp:access'
  | '*';

export interface Role {
  id: string;
  name: string;
  permissions: Permission[];
  description: string | null;
  is_system: boolean;
  created_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  display_name: string | null;
  role_id: string;
  role_name: string;
  permissions: Permission[];
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  permissions: Permission[];
  last_used_at: string | null;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
}

export interface ApiKeyCreated extends ApiKey {
  // Only returned ONCE on creation — never stored.
  raw_key: string;
}

export interface AuthAuditEntry {
  id: number;
  user_id: string | null;
  action: string;
  resource: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export type AuthMode = 'permissive' | 'enforced';
