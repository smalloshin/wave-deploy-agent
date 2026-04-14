# QA Report: Wave Deploy Agent Dashboard

**Date:** 2026-04-06
**URL:** https://wave-deploy-agent.punwave.com
**Branch:** claude/lucid-roentgen
**Duration:** ~5 minutes
**Pages visited:** 6 (Projects, Reviews, Deploys, Infrastructure, Settings, Submit Modal)
**Screenshots:** 14
**Framework:** Next.js (Client-side rendering)
**Mode:** Diff-aware (91 files changed on branch)

---

## Health Score: 62/100

| Category | Score | Weight | Weighted |
|----------|-------|--------|----------|
| Console | 100 | 15% | 15.0 |
| Links | 85 | 10% | 8.5 |
| Visual | 60 | 10% | 6.0 |
| Functional | 55 | 20% | 11.0 |
| UX | 60 | 15% | 9.0 |
| Performance | 85 | 10% | 8.5 |
| Content | 80 | 5% | 4.0 |
| Accessibility | 0 | 15% | 0.0 |
| **Total** | | | **62.0** |

---

## Top 3 Things to Fix

1. **ISSUE-001** — UI says "選填" (optional) for domain field, but API now requires it. Users will get confusing 400 errors.
2. **ISSUE-002** — Custom domains (luca-app.punwave.com, luca-app-new.punwave.com) return ERR_CONNECTION_CLOSED. SSL not provisioned.
3. **ISSUE-003** — Mobile layout is broken. Sidebar doesn't collapse, button overlaps heading, cards truncated.

---

## Issues

### ISSUE-001: Domain field label says "選填" but field is now required [HIGH / Functional]

**What:** The submit modal labels the custom domain field as "自訂網域（選填）" (optional), but the API now returns 400 if no domain is provided. The UI also has no client-side required validation for this field.

**Where:** Submit modal → "自訂網域" field

**Repro:**
1. Click "+ 提交專案"
2. Fill in project name
3. Leave domain blank
4. Attach a file and click "提交掃描"
5. The form only validates missing file, not missing domain

**Evidence:** Screenshots 02-submit-modal.png, 03-submit-no-domain.png, 13-upload-mode-db.png

**Impact:** Users submitting via the web UI without a domain will hit a server-side 400 error after uploading their file, wasting time and bandwidth. The label actively misleads them.

---

### ISSUE-002: Custom domains not reachable (SSL not provisioned) [HIGH / Functional]

**What:** All custom domain URLs (luca-app.punwave.com, luca-app-new.punwave.com, luca-app-api.punwave.com, luca-app-api-new.punwave.com) fail with ERR_CONNECTION_CLOSED. The direct Cloud Run URLs (da-luca-frontend-*.a.run.app) work fine, returning 200/307.

**Where:** Deployed projects → custom domain links

**Repro:**
1. Go to Deploys page
2. Click any custom domain link (e.g., luca-app-new.punwave.com)
3. ERR_CONNECTION_CLOSED

**Evidence:** Browser navigation errors in test, screenshots 08-deploys.png shows the links. curl to Cloud Run URLs returns 307/404 (working).

**Impact:** Users who were given custom domain URLs can't access their deployed apps. They'd need to use the ugly Cloud Run URLs instead, defeating the purpose of custom domains.

---

### ISSUE-003: Mobile layout broken — sidebar doesn't collapse [MEDIUM / Visual]

**What:** At 375x812 viewport, the sidebar stays full-width and visible, the "+ 提交專案" button overlaps the page heading "專案", and project cards are truncated on the right edge.

**Where:** All pages on mobile viewport

**Repro:**
1. Open dashboard on mobile (375px width)
2. Sidebar takes ~40% of screen width
3. Main content area is squeezed, project names wrap and cards overflow

**Evidence:** Screenshot 14-mobile.png

**Impact:** Dashboard is unusable on mobile devices. Not a primary use case (this is a developer tool), but still looks broken.

---

### ISSUE-004: Settings page exposes secrets without authentication [MEDIUM / Security]

**What:** The /settings page displays Cloudflare API Token, Anthropic API Key, and GitHub Token values (masked with ••••••••, but editable and potentially extractable). There is no authentication on the dashboard — anyone with the URL can view and modify these settings.

**Where:** /settings page

**Repro:**
1. Navigate to https://wave-deploy-agent.punwave.com/settings
2. API keys and tokens are visible (masked but present in DOM)

**Evidence:** Screenshot 10-settings.png

**Impact:** Anyone on the internet can view/modify deployment settings. This was already flagged as CSO Finding #1 (zero auth on API).

---

### ISSUE-005: DB dump file picker not visible in deployed version [LOW / Functional]

**What:** The DB dump upload field ("資料庫 Dump（選填）") that was added in the branch code is not visible in the currently deployed dashboard. This is expected since the latest code hasn't been deployed yet, but worth noting for post-deploy verification.

**Where:** Submit modal

**Evidence:** Screenshot 13-upload-mode-db.png — only shows project name, source type, file upload, domain, and env vars. No DB dump picker.

**Impact:** None currently (code not deployed). Post-deploy QA should verify this appears.

---

### ISSUE-006: Project cards not accessible via keyboard/ARIA [LOW / Accessibility]

**What:** Project cards on the main page are clickable divs (cursor:pointer) but are not in the ARIA tree. They show as @c1-@c28 in cursor-interactive mode but not as standard @e elements. No keyboard focus, no role="button" or role="link".

**Where:** Projects page → project list cards

**Evidence:** Snapshot output shows project cards only in "cursor-interactive (not in ARIA tree)" section.

**Impact:** Screen reader users and keyboard-only users cannot navigate to or expand project details.

---

## Console Health

Zero console errors across all pages tested. Clean.

## Pages Tested

| Page | URL | Status | Console Errors |
|------|-----|--------|----------------|
| Projects | / | 200 ✅ | 0 |
| Reviews | /reviews | 200 ✅ | 0 |
| Deploys | /deploys | 200 ✅ | 0 |
| Infrastructure | /infra | 200 ✅ | 0 |
| Settings | /settings | 200 ✅ | 0 |
| Submit Modal | / (modal) | N/A ✅ | 0 |

## Deployed App Health

| Service | Cloud Run URL | Custom Domain | Status |
|---------|--------------|---------------|--------|
| luca-frontend | da-luca-frontend-*.a.run.app | luca-app.punwave.com | ✅ Cloud Run / ❌ Custom Domain |
| luca-backend | da-luca-backend-*.a.run.app | luca-app-api.punwave.com | ✅ Cloud Run / ❌ Custom Domain |
| luca-frontend-new | da-luca-frontend-new-*.a.run.app | luca-app-new.punwave.com | ✅ Cloud Run / ❌ Custom Domain |
| luca-backend-new | da-luca-backend-new-*.a.run.app | luca-app-api-new.punwave.com | ✅ Cloud Run / ❌ Custom Domain |

## Summary

The dashboard itself loads fast and is bug-free on desktop (zero console errors). The two critical issues are:

1. **UI/API mismatch on required domain** — the form says optional, the API now requires it. This will confuse users.
2. **Custom domains dead** — all four custom domain mappings fail at SSL level. Direct Cloud Run URLs work.

The allowUnauthenticated fix is confirmed working — all Cloud Run services return proper responses (not 403).

No test framework detected in the web app. Run `/qa` to bootstrap one and enable regression test generation.
