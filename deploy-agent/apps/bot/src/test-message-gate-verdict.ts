/**
 * Pure-function tests for message-gate-verdict.ts (Round 26 Item #2).
 * Run via: bun src/test-message-gate-verdict.ts
 */

import { checkMessageGate } from './message-gate-verdict.js';

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

// 1. mention only → allowed-mention
(() => {
  const v = checkMessageGate({
    isMentioned: true,
    isDM: false,
    channelId: 'c-1',
    opsChannelIds: [],
  });
  check('mention only → allowed-mention', v.kind === 'allowed-mention', `got ${v.kind}`);
})();

// 2. DM only → allowed-dm
(() => {
  const v = checkMessageGate({
    isMentioned: false,
    isDM: true,
    channelId: 'c-1',
    opsChannelIds: [],
  });
  check('DM only → allowed-dm', v.kind === 'allowed-dm', `got ${v.kind}`);
})();

// 3. ops channel only → allowed-ops-channel
(() => {
  const v = checkMessageGate({
    isMentioned: false,
    isDM: false,
    channelId: 'c-ops',
    opsChannelIds: ['c-ops'],
  });
  check('ops channel only → allowed-ops-channel',
    v.kind === 'allowed-ops-channel', `got ${v.kind}`);
})();

// 4. mention + ops channel → allowed-mention (mention wins, first rule)
(() => {
  const v = checkMessageGate({
    isMentioned: true,
    isDM: false,
    channelId: 'c-ops',
    opsChannelIds: ['c-ops'],
  });
  check('mention + ops channel → allowed-mention (mention wins)',
    v.kind === 'allowed-mention', `got ${v.kind}`);
})();

// 5. none → denied-not-mentioned-no-ops
(() => {
  const v = checkMessageGate({
    isMentioned: false,
    isDM: false,
    channelId: 'c-x',
    opsChannelIds: ['c-ops'],
  });
  check('none of the gates → denied-not-mentioned-no-ops',
    v.kind === 'denied-not-mentioned-no-ops', `got ${v.kind}`);
})();

// 6. empty opsChannelIds + no mention/DM → denied
(() => {
  const v = checkMessageGate({
    isMentioned: false,
    isDM: false,
    channelId: 'c-x',
    opsChannelIds: [],
  });
  check('empty ops list + no mention/DM → denied',
    v.kind === 'denied-not-mentioned-no-ops', `got ${v.kind}`);
})();

// 7. DM with empty ops list → allowed-dm
(() => {
  const v = checkMessageGate({
    isMentioned: false,
    isDM: true,
    channelId: 'c-x',
    opsChannelIds: [],
  });
  check('DM with empty ops list → allowed-dm', v.kind === 'allowed-dm', `got ${v.kind}`);
})();

// 8. whitespace in channel id → exact compare → denied
(() => {
  const v = checkMessageGate({
    isMentioned: false,
    isDM: false,
    channelId: ' c-ops',
    opsChannelIds: ['c-ops'],
  });
  check('whitespace in channelId → exact compare → denied',
    v.kind === 'denied-not-mentioned-no-ops', `got ${v.kind}`);
})();

// 9. mention + DM → allowed-mention (mention takes precedence per rule order)
(() => {
  const v = checkMessageGate({
    isMentioned: true,
    isDM: true,
    channelId: 'c-1',
    opsChannelIds: [],
  });
  check('mention + DM → allowed-mention (mention is first rule)',
    v.kind === 'allowed-mention', `got ${v.kind}`);
})();

// 10. DM + ops channel → allowed-dm (DM is rule 2, before ops)
(() => {
  const v = checkMessageGate({
    isMentioned: false,
    isDM: true,
    channelId: 'c-ops',
    opsChannelIds: ['c-ops'],
  });
  check('DM + ops channel → allowed-dm (DM rule before ops)',
    v.kind === 'allowed-dm', `got ${v.kind}`);
})();

// 11. multi-entry ops channel list, channel matches one
(() => {
  const v = checkMessageGate({
    isMentioned: false,
    isDM: false,
    channelId: 'c-ops-2',
    opsChannelIds: ['c-ops-1', 'c-ops-2', 'c-ops-3'],
  });
  check('multi-entry ops list, channel matches → allowed-ops-channel',
    v.kind === 'allowed-ops-channel', `got ${v.kind}`);
})();

// 12. verdict shape only has kind property
(() => {
  const v = checkMessageGate({
    isMentioned: true,
    isDM: false,
    channelId: 'c-1',
    opsChannelIds: [],
  });
  const keys = Object.keys(v);
  check('verdict shape has exactly one key (kind)',
    keys.length === 1 && keys[0] === 'kind',
    `keys: ${keys.join(',')}`);
})();

// Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
