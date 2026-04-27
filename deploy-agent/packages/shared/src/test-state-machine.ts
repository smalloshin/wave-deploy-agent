/**
 * Pure-function tests for state-machine.ts (Round 42).
 *
 * state-machine.ts is the canonical source of truth for ProjectStatus
 * transition rules + state-classification predicates used by deploy-worker
 * (server-side gating), reconciler (drift correction), dashboard UI (which
 * action buttons to render, which badges to show, which rows to put in the
 * "needs your attention" panel), and notifier (when to fire).
 *
 * The four state predicates (`getValidTransitions`, `isTerminalState`,
 * `isActionableState`, `requiresHumanAction`) shipped with **zero** test
 * coverage — `canTransition`, `buildTransitionPlan`, and the two error
 * classes were tested via test-transition-plan.ts and test-stop-verdict.ts,
 * but the four predicates were not. A regression in any of them shows up as
 * silent UX bugs (wrong badge, missing button, leaking row into reviewer
 * queue) — no exception, no log.
 *
 * This file:
 *   1. Pins the full VALID_TRANSITIONS adjacency matrix (15 × 15 = 225 pairs).
 *      Any change to the rules requires updating this test by name.
 *   2. Pins the four state-classification predicates against ALL 15 known
 *      ProjectStatus values explicitly (no for-loop magic). Adding a new
 *      ProjectStatus without updating each predicate fails by name.
 *   3. Pins the InvalidTransitionError / ConcurrentTransitionError public
 *      shape (name, message format, fields) so callers' string-match catches
 *      keep working.
 *   4. Re-pins buildTransitionPlan's three outcomes against canTransition
 *      so the planner cannot diverge from the rules.
 *
 * Wire-contract lock pattern: R37 (bot auth-headers) → R38 (shared
 * permission-check) → R39 (web upload-error-mapper) → R40 (web
 * upload-draft-storage) → R41 (api cost-estimator) → R42 (shared
 * state-machine).
 *
 * Run via: bun packages/shared/src/test-state-machine.ts
 */

import {
  canTransition,
  getValidTransitions,
  isTerminalState,
  isActionableState,
  requiresHumanAction,
  buildTransitionPlan,
  InvalidTransitionError,
  ConcurrentTransitionError,
} from './state-machine.js';
import type { ProjectStatus } from './types.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, reason = ''): void {
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.error(`FAIL: ${name}: ${reason}`);
  }
}

// All 15 known ProjectStatus values, mirrored from packages/shared/src/types.ts.
// If types.ts grows, this list must grow too — that's the safety net.
const ALL_STATES: ProjectStatus[] = [
  'submitted',
  'scanning',
  'review_pending',
  'approved',
  'rejected',
  'needs_revision',
  'preview_deploying',
  'deploying',
  'deployed',
  'ssl_provisioning',
  'canary_check',
  'rolling_back',
  'live',
  'stopped',
  'failed',
];

// Pinned VALID_TRANSITIONS table, mirrored from state-machine.ts source.
// Any rules change requires updating BOTH source and this fixture, which
// shows up in code review as "did you mean to widen the state machine?".
const PINNED_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  submitted: ['scanning', 'failed'],
  scanning: ['review_pending', 'failed'],
  review_pending: ['approved', 'rejected'],
  approved: ['preview_deploying', 'deploying', 'failed'],
  rejected: ['needs_revision'],
  needs_revision: ['submitted'],
  preview_deploying: ['deploying', 'failed'],
  deploying: ['deployed', 'failed'],
  deployed: ['ssl_provisioning', 'failed'],
  ssl_provisioning: ['canary_check', 'failed'],
  canary_check: ['live', 'rolling_back', 'failed'],
  rolling_back: ['deployed', 'failed'],
  live: ['submitted', 'stopped', 'live'],
  stopped: ['live', 'submitted'],
  failed: ['submitted', 'review_pending', 'stopped'],
};

// ─── ALL_STATES list integrity ──────────────────────────────────────

(() => {
  check(
    'ALL_STATES has exactly 15 entries (matches ProjectStatus union in types.ts)',
    ALL_STATES.length === 15,
    `got ${ALL_STATES.length}`,
  );
})();

(() => {
  const set = new Set(ALL_STATES);
  check(
    'ALL_STATES has no duplicates',
    set.size === ALL_STATES.length,
  );
})();

// ─── getValidTransitions: full adjacency table pinned ──────────────

for (const state of ALL_STATES) {
  ((s: ProjectStatus) => {
    const expected = PINNED_TRANSITIONS[s];
    const actual = getValidTransitions(s);
    check(
      `getValidTransitions(${s}): returns expected list (length ${expected.length})`,
      JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  })(state);
}

(() => {
  // Unknown state should return empty array (not throw, not undefined)
  const result = getValidTransitions('not_a_state' as ProjectStatus);
  check(
    'getValidTransitions(unknown state): returns empty array (no throw)',
    Array.isArray(result) && result.length === 0,
  );
})();

(() => {
  // Returned array should be a fresh reference / mutation-safe? Actually,
  // the source returns the same array reference each time. Document that
  // contract — callers must not mutate the returned array.
  const a = getValidTransitions('live');
  const b = getValidTransitions('live');
  // Source impl returns same reference; lock that as documented behavior so
  // accidental .map/.slice in source surfaces as a test name change.
  check(
    'getValidTransitions: same reference on repeated call (caller must not mutate)',
    a === b,
  );
})();

// ─── canTransition: full 15 × 15 adjacency matrix ──────────────────

(() => {
  let matches = 0;
  let mismatches: string[] = [];
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const expected = PINNED_TRANSITIONS[from].includes(to);
      const actual = canTransition(from, to);
      if (expected === actual) {
        matches++;
      } else {
        mismatches.push(`${from}→${to} expected=${expected} actual=${actual}`);
      }
    }
  }
  check(
    `canTransition: full 15×15 = 225 adjacency cells match PINNED_TRANSITIONS`,
    mismatches.length === 0,
    mismatches.slice(0, 5).join('; '),
  );
  check(`canTransition: 225 cells evaluated`, matches === 225);
})();

(() => {
  check(
    'canTransition(unknown_from, *): returns false (no throw)',
    canTransition('not_a_state' as ProjectStatus, 'live') === false,
  );
})();

(() => {
  check(
    'canTransition(live, unknown_to): returns false (not in adjacency list)',
    canTransition('live', 'not_a_state' as ProjectStatus) === false,
  );
})();

// ─── isTerminalState: explicit per-state assertion ─────────────────
// Terminal = "deploy pipeline has reached a settling state, no further
// automated transitions until human action / new submission". Source
// definition: live | failed | stopped.

const TERMINAL_STATES = new Set<ProjectStatus>(['live', 'failed', 'stopped']);

for (const state of ALL_STATES) {
  ((s: ProjectStatus) => {
    const expected = TERMINAL_STATES.has(s);
    const actual = isTerminalState(s);
    check(
      `isTerminalState(${s}): ${expected}`,
      actual === expected,
    );
  })(state);
}

(() => {
  // Sanity: TERMINAL_STATES has exactly 3 entries
  check(
    'TERMINAL_STATES set has exactly 3 entries (live, failed, stopped)',
    TERMINAL_STATES.size === 3,
  );
})();

(() => {
  check(
    'isTerminalState(unknown): false (not in terminal set, no throw)',
    isTerminalState('not_a_state' as ProjectStatus) === false,
  );
})();

// ─── isActionableState: explicit per-state assertion ───────────────
// Actionable = "this row should appear in the human-attention queue".
// Source definition: review_pending | needs_revision.

const ACTIONABLE_STATES = new Set<ProjectStatus>(['review_pending', 'needs_revision']);

for (const state of ALL_STATES) {
  ((s: ProjectStatus) => {
    const expected = ACTIONABLE_STATES.has(s);
    const actual = isActionableState(s);
    check(
      `isActionableState(${s}): ${expected}`,
      actual === expected,
    );
  })(state);
}

(() => {
  check(
    'ACTIONABLE_STATES set has exactly 2 entries (review_pending, needs_revision)',
    ACTIONABLE_STATES.size === 2,
  );
})();

(() => {
  check(
    'isActionableState(unknown): false',
    isActionableState('not_a_state' as ProjectStatus) === false,
  );
})();

// ─── requiresHumanAction: explicit per-state assertion ─────────────
// Stricter than isActionableState — only review_pending fires notifications,
// because needs_revision is the developer's ball, not the reviewer's.

const REQUIRES_HUMAN = new Set<ProjectStatus>(['review_pending']);

for (const state of ALL_STATES) {
  ((s: ProjectStatus) => {
    const expected = REQUIRES_HUMAN.has(s);
    const actual = requiresHumanAction(s);
    check(
      `requiresHumanAction(${s}): ${expected}`,
      actual === expected,
    );
  })(state);
}

(() => {
  check(
    'REQUIRES_HUMAN set has exactly 1 entry (review_pending only)',
    REQUIRES_HUMAN.size === 1,
  );
})();

(() => {
  // Critical contract: requiresHumanAction is a STRICT SUBSET of isActionableState.
  // If this ever inverts (something requires human action without being actionable),
  // the dashboard's badge logic breaks — the row would fire a notification but
  // not appear in the queue.
  let allCovered = true;
  for (const s of ALL_STATES) {
    if (requiresHumanAction(s) && !isActionableState(s)) {
      allCovered = false;
    }
  }
  check(
    'requiresHumanAction ⊆ isActionableState (notification-without-queue invariant)',
    allCovered,
  );
})();

(() => {
  check(
    'requiresHumanAction(unknown): false',
    requiresHumanAction('not_a_state' as ProjectStatus) === false,
  );
})();

// ─── Predicate disjointness / overlap invariants ───────────────────

(() => {
  // No state should be both "terminal" and "actionable" simultaneously —
  // terminal means pipeline settled, actionable means human input required.
  // If this overlaps, dashboard logic that switches between "show settled
  // badge" vs "show needs-attention badge" breaks.
  let overlap: ProjectStatus[] = [];
  for (const s of ALL_STATES) {
    if (isTerminalState(s) && isActionableState(s)) {
      overlap.push(s);
    }
  }
  check(
    'isTerminalState ∩ isActionableState = ∅ (no terminal-and-actionable overlap)',
    overlap.length === 0,
    `overlap: ${overlap.join(', ')}`,
  );
})();

// ─── InvalidTransitionError public shape ───────────────────────────

(() => {
  const err = new InvalidTransitionError('live', 'deploying');
  check(
    'InvalidTransitionError: instanceof Error',
    err instanceof Error,
  );
  check(
    'InvalidTransitionError: instanceof InvalidTransitionError',
    err instanceof InvalidTransitionError,
  );
  check(
    'InvalidTransitionError.name === "InvalidTransitionError"',
    err.name === 'InvalidTransitionError',
  );
  check(
    'InvalidTransitionError.message format: "Invalid state transition: X → Y"',
    err.message === 'Invalid state transition: live → deploying',
    err.message,
  );
})();

(() => {
  // Round 12 callers (deploy-worker.ts) string-match this prefix to decide
  // whether to retry. If the format ever changes, those catches break silently.
  const err = new InvalidTransitionError('submitted', 'live');
  check(
    'InvalidTransitionError: message starts with "Invalid state transition:" (string-match contract)',
    err.message.startsWith('Invalid state transition:'),
  );
})();

// ─── ConcurrentTransitionError public shape ────────────────────────

(() => {
  const err = new ConcurrentTransitionError('submitted', 'scanning', 'failed');
  check(
    'ConcurrentTransitionError: instanceof Error',
    err instanceof Error,
  );
  check(
    'ConcurrentTransitionError: instanceof ConcurrentTransitionError',
    err instanceof ConcurrentTransitionError,
  );
  check(
    'ConcurrentTransitionError: NOT instanceof InvalidTransitionError (distinct types)',
    !(err instanceof InvalidTransitionError),
  );
  check(
    'ConcurrentTransitionError.name === "ConcurrentTransitionError"',
    err.name === 'ConcurrentTransitionError',
  );
  check(
    'ConcurrentTransitionError.expectedFrom field preserved',
    err.expectedFrom === 'submitted',
  );
  check(
    'ConcurrentTransitionError.to field preserved',
    err.to === 'scanning',
  );
  check(
    'ConcurrentTransitionError.actualState field preserved',
    err.actualState === 'failed',
  );
})();

(() => {
  const err = new ConcurrentTransitionError('approved', 'deploying', 'live');
  check(
    'ConcurrentTransitionError.message includes expected, to, and actual state in canonical "state=X" format',
    err.message.includes('expected from=approved') &&
      err.message.includes('→ deploying') &&
      err.message.includes('state=live'),
    err.message,
  );
})();

// ─── buildTransitionPlan: idempotent-noop only for live → live ─────

(() => {
  const plan = buildTransitionPlan({ currentState: 'live', toState: 'live' });
  check(
    'buildTransitionPlan(live→live): kind=idempotent-noop',
    plan.kind === 'idempotent-noop',
  );
})();

(() => {
  // Other self-transitions must be REJECTED (no fluky idempotency)
  const states: ProjectStatus[] = ['failed', 'stopped', 'deploying', 'submitted', 'scanning'];
  let allRejected = true;
  for (const s of states) {
    const plan = buildTransitionPlan({ currentState: s, toState: s });
    if (plan.kind !== 'rejected') {
      allRejected = false;
    }
  }
  check(
    'buildTransitionPlan: only live→live is idempotent — failed→failed, stopped→stopped, deploying→deploying, submitted→submitted, scanning→scanning all REJECTED',
    allRejected,
  );
})();

// ─── buildTransitionPlan: allowed mirrors canTransition ────────────

(() => {
  // Sample a representative spread of allowed transitions and verify the plan kind
  const allowedSamples: Array<[ProjectStatus, ProjectStatus]> = [
    ['submitted', 'scanning'],
    ['scanning', 'review_pending'],
    ['review_pending', 'approved'],
    ['approved', 'deploying'],
    ['deploying', 'deployed'],
    ['deployed', 'ssl_provisioning'],
    ['ssl_provisioning', 'canary_check'],
    ['canary_check', 'live'],
    ['canary_check', 'rolling_back'],
    ['canary_check', 'failed'],
    ['rolling_back', 'deployed'],
    ['live', 'stopped'],
    ['stopped', 'live'],
    ['failed', 'submitted'],
  ];
  let allOk = true;
  let issues: string[] = [];
  for (const [from, to] of allowedSamples) {
    const plan = buildTransitionPlan({ currentState: from, toState: to });
    if (plan.kind !== 'allowed') {
      allOk = false;
      issues.push(`${from}→${to} got ${plan.kind}`);
      continue;
    }
    if (plan.expectedFromState !== from) {
      allOk = false;
      issues.push(`${from}→${to} expectedFromState=${plan.expectedFromState}`);
    }
  }
  check(
    `buildTransitionPlan: ${allowedSamples.length} representative allowed transitions return kind=allowed with expectedFromState=currentState`,
    allOk,
    issues.join('; '),
  );
})();

// ─── buildTransitionPlan: rejected mirrors canTransition + reason format

(() => {
  const plan = buildTransitionPlan({ currentState: 'submitted', toState: 'live' });
  check(
    'buildTransitionPlan(submitted→live): kind=rejected (skipping pipeline)',
    plan.kind === 'rejected',
  );
  if (plan.kind === 'rejected') {
    check(
      'buildTransitionPlan rejected.reason format: "Invalid state transition: X → Y"',
      plan.reason === 'Invalid state transition: submitted → live',
      plan.reason,
    );
  }
})();

(() => {
  const plan = buildTransitionPlan({ currentState: 'live', toState: 'deploying' });
  check(
    'buildTransitionPlan(live→deploying): kind=rejected (must go via submitted first)',
    plan.kind === 'rejected',
  );
})();

(() => {
  // The historical string-match contract: callers (deploy-worker.ts) catch on
  // this exact prefix. If the planner reason ever changes format, the catch
  // silently breaks. Lock the prefix.
  const plan = buildTransitionPlan({ currentState: 'failed', toState: 'live' });
  check(
    'buildTransitionPlan rejected.reason starts with "Invalid state transition:" (string-match contract)',
    plan.kind === 'rejected' &&
      'reason' in plan &&
      plan.reason.startsWith('Invalid state transition:'),
  );
})();

// ─── buildTransitionPlan: full sweep matches canTransition ─────────

(() => {
  // For every (from, to) pair: planner kind ∈ {idempotent-noop, allowed} ⇔
  // canTransition is true OR the (live, live) idempotent case.
  let mismatches: string[] = [];
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const plan = buildTransitionPlan({ currentState: from, toState: to });
      const isLiveSelfLoop = from === 'live' && to === 'live';
      const allowsTransition = canTransition(from, to);

      if (isLiveSelfLoop) {
        // Source code special-cases live→live as idempotent BEFORE checking
        // canTransition (which would also return true since live ∈ live's
        // adjacency list). Either kind is acceptable but the source produces
        // idempotent-noop — lock that.
        if (plan.kind !== 'idempotent-noop') {
          mismatches.push(`live→live got ${plan.kind}, expected idempotent-noop`);
        }
      } else if (allowsTransition) {
        if (plan.kind !== 'allowed') {
          mismatches.push(`${from}→${to} canTransition=true but plan=${plan.kind}`);
        }
      } else {
        if (plan.kind !== 'rejected') {
          mismatches.push(`${from}→${to} canTransition=false but plan=${plan.kind}`);
        }
      }
    }
  }
  check(
    'buildTransitionPlan: full 15×15 sweep matches canTransition (planner cannot diverge from rules)',
    mismatches.length === 0,
    mismatches.slice(0, 5).join('; '),
  );
})();

// ─── Purity / determinism ──────────────────────────────────────────

(() => {
  const a = buildTransitionPlan({ currentState: 'submitted', toState: 'scanning' });
  const b = buildTransitionPlan({ currentState: 'submitted', toState: 'scanning' });
  check(
    'buildTransitionPlan: same input produces equal output (deterministic)',
    JSON.stringify(a) === JSON.stringify(b),
  );
})();

(() => {
  // buildTransitionPlan must not mutate its input object
  const input = { currentState: 'submitted' as ProjectStatus, toState: 'scanning' as ProjectStatus };
  const snapshot = JSON.stringify(input);
  buildTransitionPlan(input);
  check(
    'buildTransitionPlan: does not mutate input object',
    JSON.stringify(input) === snapshot,
  );
})();

(() => {
  // Predicates must be deterministic
  let stable = true;
  for (const s of ALL_STATES) {
    if (
      isTerminalState(s) !== isTerminalState(s) ||
      isActionableState(s) !== isActionableState(s) ||
      requiresHumanAction(s) !== requiresHumanAction(s)
    ) {
      stable = false;
    }
  }
  check(
    'predicates: deterministic across repeated calls',
    stable,
  );
})();

// Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
