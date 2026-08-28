import { expect, test } from '@playwright/test';

test('lobby distinguishes seated pilots from live connections', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    await host.goto('/');
    await host.getByLabel('Your display name').fill('Greg');
    await host.getByLabel('Room password', { exact: true }).fill('correct horse');
    await host.getByRole('button', { name: 'Create private room' }).click();
    await expect(host.getByRole('status')).toContainText('1 seated · 1 online');
    await expect(host.locator('#room-code-label')).toContainText('Room code:');
    const roomCode = (await host.locator('#room-code-label').textContent())?.split(': ')[1];

    const guest = await guestContext.newPage();
    await guest.goto(`/?room=${roomCode}`);
    await guest.getByLabel('Your pilot name').fill('A.Ira');
    await guest.getByLabel('Room password to join').fill('correct horse');
    await guest.getByRole('button', { name: 'Join relay room' }).click();

    await expect(guest.getByRole('status')).toContainText('2 seated · 2 online');
    await expect(host.getByRole('status')).toContainText('2 seated · 2 online');
    await guestContext.close();
    await expect(host.getByRole('status')).toContainText('2 seated · 1 online');
    await expect(host.getByRole('status')).toContainText(
      'Offline pilots will auto-pass each round until they reconnect',
    );
    await expect(host.getByText('2 SEATED · 1 ONLINE', { exact: true })).toBeVisible();
  } finally {
    await hostContext.close();
  }
});
