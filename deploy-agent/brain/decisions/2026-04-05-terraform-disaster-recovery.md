# Terraform-based Disaster Recovery for wave-deploy-agent

**Date**: 2026-04-05
**Status**: Active

## Context

`wave-deploy-agent` is a one-person ops. The current prod infra was
assembled by hand (gcloud + gsutil + console clicks) over two weeks:

- Cloud Run api + web services
- Cloud SQL Postgres instance + DB + user
- Artifact Registry repo + cleanup policies
- GCS Cloud Build bucket + lifecycle rule
- Shared Redis VM + firewall rule
- Domain mappings for `wave-deploy-agent-api.punwave.com` + `wave-deploy-agent.punwave.com`
- Cloudflare CNAMEs to `ghs.googlehosted.com`
- ~12 secrets stored as plaintext env vars on Cloud Run

**Failure modes not covered today**:
- GCP project deleted by mistake → half-day rebuild from memory
- Cloud SQL instance accidentally dropped → no automated restore path
- Service account key compromised → no clean re-provisioning
- Onboarding a second operator → no reproducible infra spec

**Bus factor**: if the maintainer forgets one env var, the rebuilt agent
refuses to start and there's no checklist to consult.

## Decision

Codify all agent-own infra in Terraform under `deploy-agent/terraform/`,
split into focused files:

```
versions.tf   variables.tf   backend.tf    outputs.tf
bootstrap.tf  (APIs, service account, IAM)
secrets.tf    (Secret Manager: 6 secrets, read by runtime SA)
storage.tf    (GCS cloudbuild bucket + AR repo + lifecycle/cleanup policies)
database.tf   (Cloud SQL with deletion_protection + 14 backups + PITR)
redis.tf      (shared Redis VM + firewall)
services.tf   (Cloud Run api + web, secrets injected from Secret Manager)
domains.tf    (Cloud Run domain mappings)
```

State stored in versioned GCS bucket `${project}-tfstate/deploy-agent`.

One-shot `bootstrap.sh` rebuilds everything from zero:
1. Enable APIs
2. Create tfstate bucket
3. `terraform init` + `plan` + `apply`
4. Trigger first Cloud Build
5. Print DNS CNAMEs to set in Cloudflare

**Secrets migration**: all 6 sensitive values (DB password, Redis password,
Anthropic/OpenAI keys, GitHub PAT, Cloudflare token) moved from plaintext
Cloud Run env vars → Secret Manager, injected via `value_source.secret_key_ref`.

## Consequences

### Good
- **DR time drops from ~4h manual → ~20min scripted**
- **Secrets properly encrypted at rest** + audit trail on access
- **Onboarding doc is the terraform itself** — single source of truth
- **Prevents drift**: `terraform plan` catches divergence from spec
- **Versioned state** — can rollback tfstate corruption

### Trade-offs
- **Existing infra not imported yet** (Phase 1 scope): TF apply against
  live project would try to create duplicate resources. Mitigated by:
  - `deletion_protection = true` on Cloud SQL
  - `lifecycle.ignore_changes = [image]` on Cloud Run (build pipeline owns image tags)
  - Bootstrap script has confirmation prompts
- **Cloudflare DNS still manual** — TF outputs records to create, but user
  must paste in UI. Phase 2 will add Cloudflare provider.
- **User project resources NOT in TF** — those are managed by the agent at
  runtime (redis-provisioner.ts, db-provisioner.ts). Correct separation.

### Explicitly NOT in scope (yet)
- `terraform import` path to adopt existing prod resources into TF state
  (documented in README, deferred until we actually need DR or want to
  eliminate drift risk)
- Cloud DNS or Cloudflare provider for automated DNS
- Cloud SQL read replica / HA tier
- Automated schema migration runner in Cloud Run (manual `migrate.ts` for now)

## Verification plan

Can't test destructively on prod. Validation path:
1. Create throwaway GCP project `wave-deploy-agent-dr-test`
2. Point tfvars at it + run `./bootstrap.sh`
3. Verify `curl <api_url>/health` returns ok within 20 min
4. Destroy project

Do this **after the next deploy pain point** to stay honest.

## Follow-up

- [ ] Run end-to-end bootstrap test in a throwaway project
- [ ] Write `IMPORT.md` with full `terraform import` command list
- [ ] Migrate current prod Cloud Run env vars → Secret Manager (low-risk,
      one-service-at-a-time)
- [ ] Add Cloudflare provider for DNS automation (Phase 2)
- [ ] Add `apps/api/src/routes/internal.ts` with `/api/internal/migrate`
      endpoint so bootstrap.sh can run schema migrations automatically
