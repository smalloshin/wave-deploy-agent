import type { ProjectStatus } from './types';

const VALID_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
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
  canary_check: ['live', 'rolling_back'],
  rolling_back: ['deployed', 'failed'],
  live: ['submitted', 'stopped'], // resubmit for new version, or manually stop
  stopped: ['live', 'submitted'], // restart (deploy last image) or full rescan
  failed: ['submitted', 'review_pending', 'stopped'], // retry, skip-scan, or give up
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getValidTransitions(from: ProjectStatus): ProjectStatus[] {
  return VALID_TRANSITIONS[from] ?? [];
}

export function isTerminalState(status: ProjectStatus): boolean {
  return status === 'live' || status === 'failed' || status === 'stopped';
}

export function isActionableState(status: ProjectStatus): boolean {
  return status === 'review_pending' || status === 'needs_revision';
}

export function requiresHumanAction(status: ProjectStatus): boolean {
  return status === 'review_pending';
}

export class InvalidTransitionError extends Error {
  constructor(from: ProjectStatus, to: ProjectStatus) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}
