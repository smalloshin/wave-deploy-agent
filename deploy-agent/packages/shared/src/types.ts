// ─── LLM Env Intelligence Types ───

export type EnvVarAction =
  | 'keep'                    // Value is production-ready, use as-is
  | 'replace_with_cloudsql'   // DB connection → replace with Cloud SQL socket URL
  | 'replace_with_redis'      // Redis connection → replace with provisioned Redis URL
  | 'generate_secret'         // Weak/placeholder secret → generate strong random value
  | 'delete'                  // Fake placeholder → remove entirely (better than deploying garbage)
  | 'needs_user_input';       // External API key or user-specific → user must provide

export interface EnvVarVerdict {
  variable: string;
  action: EnvVarAction;
  reason: string;             // Human-readable explanation (繁體中文)
  currentValue: string;       // Masked for security
  suggestedValue?: string;    // Only for generate_secret (the actual generated value)
  confidence: number;         // 0-1, below 0.7 auto-downgrades to needs_user_input
  category: 'database' | 'cache' | 'secret' | 'api_key' | 'url' | 'config' | 'unknown';
}

export interface EnvClassificationResult {
  verdicts: EnvVarVerdict[];
  summary: string;            // 中文摘要
  provider: 'claude' | 'gpt' | 'fallback';
  autoActionCount: number;    // How many vars LLM will auto-handle
  needsUserCount: number;     // How many vars need user input
}

// ─── Project Types ───

export type ProjectStatus =
  | 'submitted'
  | 'scanning'
  | 'review_pending'
  | 'approved'
  | 'rejected'
  | 'needs_revision'
  | 'preview_deploying'
  | 'deploying'
  | 'deployed'
  | 'ssl_provisioning'
  | 'canary_check'
  | 'rolling_back'
  | 'live'
  | 'stopped'
  | 'failed';

export type ScanSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type AutoFixAction = 'auto_fix' | 'report_only';

export type ReviewDecision = 'approved' | 'rejected';

export type SourceType = 'upload' | 'git' | 'openclaw';

export type DeployTarget = 'cloud_run';

export interface Project {
  id: string;
  name: string;
  slug: string;
  sourceType: SourceType;
  sourceUrl: string | null;
  detectedLanguage: string | null;
  detectedFramework: string | null;
  status: ProjectStatus;
  config: ProjectConfig;
  createdAt: Date;
  updatedAt: Date;
  /** RBAC Phase 1: user UUID who owns this project. NULL = legacy
   *  unbackfilled row (admin-only). Set on createProject from req.auth. */
  ownerId: string | null;
}

export interface ProjectConfig {
  deployTarget: DeployTarget;
  customDomain?: string;
  allowUnauthenticated: boolean;
  gcpProject?: string;
  gcpRegion?: string;
  gcsSourceUri?: string;  // GCS URI for the ORIGINAL user upload (preserved for audit)
  gcsFixedSourceUri?: string;  // GCS URI for post-fix projectDir (AI修補+生成的Dockerfile)，由 pipeline-worker 產出，deploy-worker 優先使用
  envVars?: Record<string, string>;  // User-provided env vars (merged with auto-detected)
  detectedPort?: number;             // Port detected during pipeline scan (fallback when source is gone)
  // Project grouping (always set; single-service projects are a group of 1)
  projectGroup?: string;           // Shared group ID linking sibling services
  groupName?: string;              // Display name for the group (e.g. "kol-studio")
  serviceRole?: 'backend' | 'frontend';  // Role determines deploy order & URL injection
  serviceDirName?: string;         // Original subdirectory name within monorepo
  siblings?: Array<{ name: string; role: string; dirName: string }>;
  // Cached last-deployed image for stop/start lifecycle
  lastDeployedImage?: string;      // e.g. asia-east1-docker.pkg.dev/.../api:v123
  // Domain conflict handling
  forceDomain?: boolean;           // Override existing domain mapping if conflict detected
  // Backend URL resolved after deploy (for monorepo frontend→backend wiring)
  resolvedBackendUrl?: string;
  // Database dump restore
  gcsDbDumpUri?: string;           // GCS URI of user-uploaded DB dump file
  dbDumpFileName?: string;         // Original filename (for format detection)
  dbRestoreResult?: {
    success: boolean;
    format: string;
    durationMs: number;
    bytesRestored: number;
    error: string | null;
  };
  // LLM env var analysis results (for dashboard visibility)
  envAnalysis?: {
    verdicts: EnvVarVerdict[];
    summary: string;
    provider: string;
    autoActionCount: number;
    needsUserCount: number;
    // Legacy fields (kept for backward compat)
    placeholders?: Array<{ variable: string; value: string; reason: string }>;
    missingCritical?: Array<{ variable: string; reason: string }>;
    recommendations?: string[];
  };
  // Domain error tracking
  domainError?: string;
  domainErrorAt?: string;
  // Versioning: deploy lock prevents auto-publish of new versions
  deployLocked?: boolean;
}

// ─── Project Group (aggregated view of related services + resources) ───

export interface ProjectGroup {
  groupId: string;
  groupName: string;
  createdAt: Date;
  updatedAt: Date;
  serviceCount: number;
  liveCount: number;
  stoppedCount: number;
  failedCount: number;
  services: ProjectWithResources[];
}

export interface ProjectWithResources extends Project {
  resources: ProjectResource[];
  latestDeployment: {
    cloudRunService: string | null;
    cloudRunUrl: string | null;
    customDomain: string | null;
    deployedAt: Date | null;
    healthStatus?: string | null;
    sslStatus?: string | null;
  } | null;
}

export interface ProjectResource {
  kind: 'cloud_run' | 'redis_db' | 'postgres_db' | 'gcs_source' | 'custom_domain';
  label: string;                   // Human-readable (e.g. "Cloud Run: da-foo")
  detail?: string;                 // Extra info (e.g. "db0 · prefix=proj:foo:")
  reference?: string;              // Underlying identifier (service name, db name, gs:// URI)
  removable: boolean;              // Whether user can stop/delete this resource
}

export interface ScanFinding {
  id: string;
  tool: 'semgrep' | 'trivy' | 'llm';
  category: string;
  severity: ScanSeverity;
  title: string;
  description: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  action: AutoFixAction;
  fix?: AutoFixResult;
}

export interface AutoFixResult {
  applied: boolean;
  diff: string;
  explanation: string;
  verificationPassed: boolean | null;
}

export interface ScanReport {
  id: string;
  projectId: string;
  version: number;
  findings: ScanFinding[];
  autoFixes: AutoFixRecord[];
  threatSummary: string;
  costEstimate: CostEstimate | null;
  resourcePlan: ResourcePlan | null;
  status: 'scanning' | 'completed' | 'failed';
  createdAt: Date;
}

export interface AutoFixRecord {
  findingId?: string;
  filePath?: string;
  originalCode?: string;
  fixedCode?: string;
  explanation: string;
  applied?: boolean;
  diff?: string;
}

// ─── Resource Requirements (LLM-detected external dependencies) ───

export type ResourceType =
  | 'redis'
  | 'postgres'
  | 'mysql'
  | 'mongodb'
  | 'object_storage'
  | 'smtp'
  | 'external_api'  // e.g. Stripe, OpenAI — user must provide their own key
  | 'unknown';

export type ResourceUseCase =
  | 'cache'
  | 'queue'           // BullMQ, Redis queue
  | 'pubsub'
  | 'session_store'
  | 'primary_database'
  | 'rate_limiting'
  | 'file_storage'
  | 'email'
  | 'payment'
  | 'ai_llm'
  | 'other';

export type ProvisioningStrategy =
  | 'auto_provision'     // deploy-agent will provision (shared Redis, Cloud SQL)
  | 'user_provided'      // user must supply the URL/key
  | 'already_configured' // env var already set by user
  | 'skip';              // not strictly needed

export interface ResourceRequirement {
  /** External service type */
  type: ResourceType;
  /** What the project uses it for */
  useCase: ResourceUseCase;
  /** Is this required for the app to start, or optional? */
  required: boolean;
  /** LLM's reasoning why this is needed (shown to user) */
  reasoning: string;
  /** Evidence from the code (import statements, env vars, etc.) */
  evidence: string[];
  /** How should this be provisioned? */
  strategy: ProvisioningStrategy;
  /** Env vars that will be set for this resource */
  envVars: Array<{
    key: string;
    description: string;
    required: boolean;
    example?: string;
  }>;
  /** Size/tier recommendation (e.g. "small", "1GB", "shared") */
  sizing?: string;
  /** Status of provisioning (filled in after provision step) */
  provisioned?: {
    success: boolean;
    providerInfo?: string;
    injectedEnvVars?: Record<string, string>;
    error?: string;
  };
}

export interface ResourcePlan {
  /** LLM-generated deployment plan summary (bilingual) */
  summary: string;
  /** List of detected resource requirements */
  requirements: ResourceRequirement[];
  /** Env vars the user still needs to provide manually */
  missingUserEnvVars: Array<{
    key: string;
    description: string;
    example?: string;
  }>;
  /** LLM provider used */
  provider: 'claude' | 'openai' | 'fallback';
  /** Can deploy proceed automatically? */
  canAutoDeploy: boolean;
  /** Blocking issues that prevent auto-deploy */
  blockers: string[];
}

export interface CostEstimate {
  monthlyTotal: number;
  breakdown: {
    compute: number;
    storage: number;
    networking: number;
    ssl: number;
  };
  currency: 'USD';
}

export interface Review {
  id: string;
  scanReportId: string;
  reviewerEmail: string | null;
  decision: ReviewDecision | null;
  comments: string | null;
  previewUrl: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface Deployment {
  id: string;
  projectId: string;
  reviewId: string | null;
  cloudRunService: string | null;
  cloudRunUrl: string | null;
  customDomain: string | null;
  sslStatus: string | null;
  terraformConfig: string | null;
  healthStatus: 'unknown' | 'healthy' | 'unhealthy' | 'rolling_back';
  canaryResults: CanaryResult | null;
  gitPrUrl: string | null;
  deployedAt: Date | null;
  createdAt: Date;
  // Versioning (Netlify-like immutable deploy model)
  version: number;
  imageUri: string | null;
  revisionName: string | null;
  previewUrl: string | null;
  isPublished: boolean;
  publishedAt: Date | null;
  // Deployed source snapshot (post-fix code, gs://wave-deploy-agent-deployed/{slug}/v{n}.tgz)
  deployedSourceGcsUri: string | null;
}

export interface CanaryResult {
  checks: CanaryCheck[];
  passed: boolean;
  rolledBack: boolean;
}

export interface CanaryCheck {
  type: 'http_health' | 'error_rate' | 'latency';
  passed: boolean;
  value: number;
  threshold: number;
  timestamp: Date;
}

export interface StateTransition {
  id: number;
  projectId: string;
  fromState: ProjectStatus | null;
  toState: ProjectStatus;
  triggeredBy: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}
