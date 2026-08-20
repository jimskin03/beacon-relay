import { expect, test, type BrowserContext, type Page } from '@playwright/test';

test('five isolated clients complete a deterministic cooperative victory', async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      const context = await browser.newContext();
      contexts.push(context);
      pages.push(await context.newPage());
    }

    const [greg, aira, aixin, ainova, airis] = pages as [Page, Page, Page, Page, Page];
    await greg.goto('/');
    await greg.getByLabel('Your display name').fill('Greg');
    await greg.getByLabel('Room password', { exact: true }).fill('correct horse');
    await greg.getByRole('button', { name: 'Create private room' }).click();
    await expect(greg.getByRole('status')).toContainText('Lobby: 1 of 5 pilots connected');
    const roomText = await greg.locator('#room-code-label').textContent();
    const roomCode = roomText?.split(': ')[1];
    expect(roomCode).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const joiners: Array<[Page, string]> = [
      [aira, 'A.Ira'],
      [aixin, 'A.IXiin'],
      [ainova, 'A.INova'],
      [airis, 'A.IRis'],
    ];
    for (const [page, name] of joiners) {
      await page.goto(`/?room=${roomCode}`);
      await page.getByLabel('Your pilot name').fill(name);
      await page.getByLabel('Room password to join').fill('correct horse');
      await page.getByRole('button', { name: 'Join relay room' }).click();
    }

    for (const page of pages) {
      await expect(page.getByRole('status')).toContainText('Round 1 of 8');
      await expect(page.locator('#round-label')).toHaveText(/ROUND 1\/8 · \d+s/);
    }

    const plans = [
      ['west', 'west', 'west', 'north', 'north', 'north'],
      ['east', 'east', 'east', 'north', 'north', 'north'],
      ['south', 'south', 'south', 'pass', 'pass', 'pass'],
      ['pass', 'pass', 'pass', 'pass', 'pass', 'pass'],
      ['pass', 'pass', 'pass', 'pass', 'pass', 'pass'],
    ] as const;

    for (let roundIndex = 0; roundIndex < 6; roundIndex += 1) {
      for (let playerIndex = 0; playerIndex < pages.length; playerIndex += 1) {
        const action = plans[playerIndex]![roundIndex]!;
        const label = action === 'pass' ? 'Pass this round' : `Move ${action}`;
        await pages[playerIndex]!.getByRole('button', { name: label }).click();
      }
      if (roundIndex < 5) {
        for (const page of pages) {
          await expect(page.getByRole('status')).toContainText(`Round ${roundIndex + 2} of 8`);
        }
      }
    }

    for (const page of pages) {
      await expect(page.getByRole('status')).toContainText('Mission complete');
      await expect(page.locator('.cell.beacon.active')).toHaveCount(3);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
