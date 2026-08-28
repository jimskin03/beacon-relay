import { expect, test } from '@playwright/test';

test('sound controls require a gesture and persist the player preference', async ({ page }) => {
  await page.goto('/');

  const toggle = page.getByRole('button', { name: 'Sound: Off' });
  const volume = page.getByLabel('Volume');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(volume).toBeDisabled();

  await toggle.click();
  await expect(page.getByRole('button', { name: 'Sound: On' })).toHaveAttribute('aria-pressed', 'true');
  await expect(volume).toBeEnabled();
  await volume.fill('0.45');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Sound: On' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Volume')).toHaveValue('0.45');
});
