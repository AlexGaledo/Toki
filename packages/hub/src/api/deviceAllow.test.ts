import { describe, it, expect } from 'vitest';
import { DEVICE_ALLOW } from './guard.js';

const CHANGED =
  'you changed what paired phones can reach; confirm it is intended, then update the snapshot ' +
  '(pnpm --filter @pocketrocket/hub exec vitest run -u src/api/deviceAllow.test.ts) and say why in the PR. ' +
  'Settings, secrets, account, integrations, approval rules and bot/room/skill/memory writes stay hub-token only.';

describe('pr-backend.md: "DEVICE_ALLOW: a new route is refused for devices unless you add it to the allowlist on purpose. Settings, secrets, account, integrations, approval rules, bot/room/skill/memory writes stay hub-token only."', () => {
  it('DEVICE_ALLOW matches the reviewed snapshot', async () => {
    const lines = DEVICE_ALLOW.map(([method, re]) => `${method.padEnd(6)} ${re.source}`).join('\n') + '\n';
    await expect(lines, CHANGED).toMatchFileSnapshot('./__snapshots__/deviceAllow.txt');
  });
});
