// Discord operator allowlist verdict.
//
// Why this exists:
//   Before Round 26, anyone with @mention access to the bot in any
//   shared guild could ask it to publish/rollback/delete projects.
//   That's fine in a 1-person org but unacceptable as soon as a
//   second user joins the workspace. The OPERATOR_DISCORD_IDS env
//   var declares who's allowed; this verdict is the gate.
//
//   "Empty allowlist" is treated as a fresh-install signal: the
//   verdict is `allowed-empty-allowlist` (open mode), but the bot
//   logs a loud warning every NL request so operators can't forget
//   to set the env var. Production deployments MUST set it.
//
// Pattern: pure function, discriminated union, zero side effects
// (the warn is the caller's responsibility).
//
// Caller (nl-handler.handleNaturalLanguage) runs this immediately
// after computing userText and BEFORE calling the LLM. Denied →
// short reply + return; empty-allowlist → console.warn + continue.

export type AllowlistVerdict =
  | { kind: 'allowed' }
  | { kind: 'denied-not-on-allowlist' }
  | { kind: 'allowed-empty-allowlist' };

export interface AllowlistInput {
  /** The Discord user snowflake of the message author. */
  discordUserId: string;
  /** Comma-separated env var, parsed to string[] in config.ts. */
  allowlist: string[];
}

export function checkAllowlist(opts: AllowlistInput): AllowlistVerdict {
  if (opts.allowlist.length === 0) {
    // Open mode — allow but force the caller to log a warning.
    // Production deployments should always populate OPERATOR_DISCORD_IDS.
    return { kind: 'allowed-empty-allowlist' };
  }
  if (opts.allowlist.includes(opts.discordUserId)) {
    return { kind: 'allowed' };
  }
  return { kind: 'denied-not-on-allowlist' };
}
