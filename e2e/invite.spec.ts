import { expect, test } from '@playwright/test';

test('host issues a one-time passwordless agent invite', async ({ browser }) => {
  const hostContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const agentContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    await host.goto('/');
    await host.getByLabel('Your display name').fill('Greg');
    await host.getByLabel('Room password', { exact: true }).fill('correct horse');
    await host.getByRole('button', { name: 'Create private room' }).click();
    await expect(host.getByRole('status')).toContainText('Lobby: 1 of 5 pilots connected');
    await host.getByRole('button', { name: 'Copy agent invite' }).click();
    await expect(host.getByRole('status')).toContainText('One-time agent invite copied');
    const inviteUrl = await host.evaluate(() => navigator.clipboard.readText());
    expect(inviteUrl).toMatch(/\?room=[A-Za-z0-9_-]{16}#invite=[A-Za-z0-9_-]{32,}$/);

    const agent = await agentContext.newPage();
    await agent.goto(inviteUrl);
    await expect(agent.getByLabel('Room password to join')).toBeHidden();
    await agent.getByLabel('Your pilot name').fill('A.Ira');
    await agent.getByRole('button', { name: 'Join with secure invite' }).click();
    await expect(agent.getByRole('status')).toContainText('Lobby: 2 of 5 pilots connected');
    await expect(agent.getByRole('button', { name: 'Copy agent invite' })).toBeHidden();
  } finally {
    await hostContext.close();
    await agentContext.close();
  }
});
