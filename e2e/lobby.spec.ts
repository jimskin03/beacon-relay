import { expect, test } from '@playwright/test';

test('host creates a private room from the accessible lobby', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Beacon Relay' })).toBeVisible();
  await page.getByLabel('Your display name').fill('Greg');
  await page.getByLabel('Room password', { exact: true }).fill('correct horse');
  await page.getByRole('button', { name: 'Create private room' }).click();

  await expect(page.getByRole('status')).toContainText('Lobby: 1 seated · 1 online');
  await expect(page.getByText(/Room code:/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy agent invite' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start mission' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sound: Off' })).toBeVisible();
  await expect(page.locator('#board')).toHaveClass(/lobby-board/);
  await expect(page.getByText('MISSION READINESS')).toBeVisible();
  expect(await page.locator('#board').evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(360);

  await page.reload();
  await expect(page.getByRole('status')).toContainText('Lobby: 1 seated · 1 online');
  await expect(page.getByText(/Room code:/)).toBeVisible();

  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.locator('#landing')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Lobby: 1 seated · 1 online');
});
