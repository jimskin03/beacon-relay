import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

test('four persistent profile runners autonomously complete a hosted-style game', async ({ page }) => {
  const runners: ChildProcess[] = [];
  try {
    await page.goto('/');
    await page.getByLabel('Your display name').fill('Greg');
    await page.getByLabel('Room password', { exact: true }).fill('correct horse');
    await page.getByRole('button', { name: 'Create private room' }).click();
    await expect(page.getByRole('status')).toContainText('Lobby: 1 seated · 1 online');

    const credentials = await page.evaluate(() => JSON.parse(sessionStorage.getItem('beacon-relay-session')!));
    const pilots = [
      ['default', 'A.Ira'],
      ['aixin', 'A.IXiin'],
      ['ainova', 'A.INova'],
      ['airis', 'A.IRis'],
    ] as const;

    for (const [profile, name] of pilots) {
      const inviteToken = await page.evaluate(async ({ roomCode, token }) => {
        const response = await fetch(`/api/rooms/${roomCode}/invites`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        return (await response.json()).inviteToken as string;
      }, credentials);
      const inviteUrl = `${new URL(page.url()).origin}/?room=${credentials.roomCode}#invite=${inviteToken}`;
      const runner = spawn(
        './node_modules/.bin/tsx',
        [
          'src/runner/agent-runner.ts',
          '--profile', profile,
          '--name', name,
          '--invite', inviteUrl,
          '--decision', 'fallback',
        ],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      runners.push(runner);
    }

    await expect(page.locator('#pilot-count')).toHaveText('5/10', { timeout: 20_000 });
    await page.getByRole('button', { name: 'Start mission' }).click();
    await expect(page.getByRole('status')).toContainText('Round 1 of 8', { timeout: 20_000 });
    for (let round = 1; round <= 6; round += 1) {
      await page.getByRole('button', { name: 'Pass this round' }).click();
      if (round < 6) {
        await expect(page.getByRole('status')).toContainText(`Round ${round + 1} of 8`, {
          timeout: 20_000,
        });
      }
    }
    await expect(page.getByRole('status')).toContainText('Mission complete', { timeout: 20_000 });
    await expect(page.locator('.cell.beacon.active')).toHaveCount(3);
  } finally {
    for (const runner of runners) runner.kill('SIGTERM');
  }
});
