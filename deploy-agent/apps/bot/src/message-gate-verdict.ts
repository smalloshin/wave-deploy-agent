// Message-gate verdict — decides whether a Discord message should be
// processed by the NL handler.
//
// Pre-Round-26 the gate was: `isMentioned || isDM`. That made operators
// type "@bot please publish luca v3" every time, which is annoying and
// also missed the fact that operators in dedicated ops channels have
// already opted in to bot interaction.
//
// New rules (in order):
//   1. @mention → allowed-mention   (back-compat: existing flows still work)
//   2. DM → allowed-dm              (back-compat)
//   3. message in OPS_CHANNEL_IDS → allowed-ops-channel
//      (drops the @mention requirement in trusted channels)
//   4. otherwise → denied-not-mentioned-no-ops (silent ignore)
//
// "Silent ignore" means the bot doesn't reply — replying to every
// non-bot message in a shared channel would be spam. The verdict is
// returned so the caller knows to `return` early.

export type MessageGateVerdict =
  | { kind: 'allowed-mention' }
  | { kind: 'allowed-dm' }
  | { kind: 'allowed-ops-channel' }
  | { kind: 'denied-not-mentioned-no-ops' };

export interface MessageGateInput {
  /** True if the message @mentions the bot user. */
  isMentioned: boolean;
  /** True if the message arrived via DM (no guild). */
  isDM: boolean;
  /** Channel snowflake of the incoming message. */
  channelId: string;
  /** Allowlist from config.opsChannelIds (parsed env var). */
  opsChannelIds: string[];
}

export function checkMessageGate(opts: MessageGateInput): MessageGateVerdict {
  if (opts.isMentioned) return { kind: 'allowed-mention' };
  if (opts.isDM) return { kind: 'allowed-dm' };
  if (opts.opsChannelIds.includes(opts.channelId)) {
    return { kind: 'allowed-ops-channel' };
  }
  return { kind: 'denied-not-mentioned-no-ops' };
}
