import { expect, test } from '@playwright/test';

test('host creates a private room from the accessible lobby', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Beacon Relay' })).toBeVisible();
  await page.getByLabel('Your display name').fill('Greg');
  await page.getByLabel('Room password', { exact: true }).fill('correct horse');
  await page.getByRole('button', { name: 'Create private room' }).click();

  await expect(page.getByRole('status')).toContainText('Lobby: 1 of 5 pilots connected');
  await expect(page.getByText(/Room code:/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy agent invite' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('status')).toContainText('Lobby: 1 of 5 pilots connected');
  await expect(page.getByText(/Room code:/)).toBeVisible();
});
