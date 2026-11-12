import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createWorkspaceRunner } from '../../server/workspace.mjs';
import { workspaceDocker } from '../fixtures/workspace-docker.mjs';

async function fixture(page) {
  const states = new Map();
  const fake = workspaceDocker();
  const runner = createWorkspaceRunner({
    store: {
      workspace: (id) => structuredClone(states.get(id)),
      saveWorkspace: (id, state) => states.set(id, structuredClone(state)),
    },
    ...fake,
    hardwareLock: false,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.route('**/api/workspace', async (route) => {
    const request = route.request();
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    const result = body
      ? await runner.execute(body.task, body.action, body.draft)
      : await runner.status();
    await route.fulfill({
      status: result.httpStatus ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(result),
    });
  });
  await page.goto('/#lab');
  await expect(page.getByLabel('JSON-рецепт')).toBeVisible();
  return { runner, states, errors };
}
async function prepare(page) {
  await page.getByRole('button', { name: '1. Подготовить новую попытку' }).click();
  await page.getByRole('button', { name: 'Подтвердить сброс' }).click();
  await expect(page.getByRole('button', { name: '2. Записать из рецепта' })).toBeEnabled();
}
async function editCommit(page, commit) {
  const editor = page.getByLabel('JSON-рецепт');
  const recipe = JSON.parse(await editor.inputValue());
  recipe.consumer.commit = commit;
  await editor.fill(JSON.stringify(recipe, null, 2));
}

test('task selection survives reload and reset confirmation stays beside its action with keyboard focus', async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator('.workspace-task').filter({ hasText: 'Брокер недоступен' }).click();
  await expect(page).toHaveURL(/#lab\/recovery$/);
  await page.reload();
  await expect(page.locator('.workspace-task[aria-pressed="true"]')).toContainText(
    'Брокер недоступен',
  );
  const trigger = page.getByRole('button', { name: '1. Подготовить новую попытку', exact: true });
  await trigger.click();
  const confirmation = page.getByRole('group', { name: 'Подтверждение сброса' });
  await expect(confirmation).toBeFocused();
  const triggerBox = await trigger.boundingBox();
  const confirmBox = await confirmation.boundingBox();
  expect(confirmBox.y - (triggerBox.y + triggerBox.height)).toBeLessThan(40);
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(confirmation).toHaveCount(0);
});

test('workspace edits recipe, refuses premature credit, recovers commits, persists history and resets only its attempt', async ({
  page,
}) => {
  const { errors } = await fixture(page);
  await prepare(page);
  await page.getByRole('button', { name: 'Проверить результат', exact: true }).click();
  await expect(page.locator('.workspace-result')).not.toContainText('Результат проверен');
  await page.getByRole('button', { name: '2. Записать из рецепта' }).click();
  await page.getByRole('button', { name: '3. Прочитать группой' }).click();
  await page.getByRole('button', { name: 'Проверить результат', exact: true }).click();
  await expect(page.locator('.workspace-notice')).toContainText('не зачтено');
  await editCommit(page, true);
  await page.getByRole('button', { name: 'Сохранить рецепт' }).click();
  await expect(page.getByRole('status')).toContainText('Рецепт сохранён');
  await page.reload();
  await expect(page.getByLabel('JSON-рецепт')).toContainText('"commit": true');
  await page.getByRole('button', { name: '3. Прочитать группой' }).click();
  await page.getByRole('button', { name: 'Проверить результат', exact: true }).click();
  await expect(page.locator('.workspace-result')).toContainText('Результат проверен');
  await page.getByRole('button', { name: 'История по шагам' }).click();
  await expect(page.locator('.cluster-scene')).toContainText('ЗАПИСЬ ЗАПУСКА');
  await expect(page.getByRole('button', { name: '2. Записать из рецепта' })).toBeDisabled();
  await page.getByRole('button', { name: 'К текущему стенду' }).click();
  const count = await page.locator('.workspace-timeline li').count();
  await prepare(page);
  await expect(page.locator('.workspace-result')).toContainText('Попытка 2');
  expect(await page.locator('.workspace-timeline li').count()).toBeGreaterThan(count);
  expect(errors).toEqual([]);
});
test('workspace renders real failure evidence and restores all replicas without false credit', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: /Брокер недоступен/ }).click();
  await prepare(page);
  await page.getByRole('button', { name: 'Отключить broker 3' }).click();
  await expect(page.locator('.cluster-rack.is-down')).toHaveCount(1);
  await page.getByRole('button', { name: '2. Записать из рецепта' }).click();
  await expect(page.locator('.cluster-rack.is-down .replica-cells i')).toHaveCount(0);
  await expect(page.locator('.cluster-rack.is-down .replica-unmeasured')).toHaveCount(3);
  await page.getByRole('button', { name: 'Проверить результат', exact: true }).click();
  await expect(page.locator('.workspace-notice')).toContainText('не зачтено');
  await page.getByRole('button', { name: 'Восстановить broker 3' }).click();
  await expect(page.locator('.cluster-rack.is-down')).toHaveCount(0);
  await editCommit(page, true);
  await page.getByRole('button', { name: '3. Прочитать группой' }).click();
  await page.getByRole('button', { name: 'Проверить результат', exact: true }).click();
  await expect(page.locator('.workspace-result')).toContainText('Результат проверен');
});
test('workspace keyboard, layouts, accessibility and static state at 320/390/768/1440', async ({
  page,
}) => {
  const { errors } = await fixture(page);
  await prepare(page);
  await page.getByRole('button', { name: '2. Записать из рецепта' }).click();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('.cluster-scene').scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await expect
      .poll(() =>
        page.locator('.cluster-viewport').evaluate((view) => {
          const v = view.getBoundingClientRect();
          return [...view.querySelectorAll('.cluster-rack,.cluster-endpoint')].every((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.left >= v.left - 1 &&
              r.right <= v.right + 1 &&
              r.top >= v.top - 1 &&
              r.bottom <= v.bottom + 1
            );
          });
        }),
      )
      .toBe(true);
    const violations = (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations;
    expect(violations).toEqual([]);
  }
  const flat = page.getByRole('button', { name: 'Плоский вид топологии' });
  await flat.focus();
  await page.keyboard.press('Enter');
  await expect(flat).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cluster-scene')).toHaveAttribute('data-motion', 'reduced');
  expect(errors).toEqual([]);
});
test('workspace playback freezes on pause, offscreen and document hidden, reduced motion stops its timer', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await fixture(page);
  await prepare(page);
  await page.getByRole('button', { name: '2. Записать из рецепта' }).click();
  await page.getByRole('button', { name: '2. Записать из рецепта' }).click();
  await page.getByRole('button', { name: '3. Прочитать группой' }).click();
  await page.locator('.workspace-timeline button').nth(1).click();
  const firstPacket = await page.locator('.cluster-packet').elementHandle();
  expect(firstPacket).not.toBeNull();
  await page.locator('.workspace-timeline button').nth(2).click();
  expect(await firstPacket.evaluate((node) => node.isConnected)).toBe(false);
  await expect(page.locator('.cluster-packet')).toHaveCount(1);
  await page.getByRole('button', { name: 'История по шагам' }).click();
  await page.locator('.cluster-scene').scrollIntoViewIfNeeded();
  const play = page.getByRole('button', { name: 'Воспроизвести запись', exact: true });
  if (await play.isVisible()) await play.click();
  await page.getByRole('button', { name: 'Приостановить запись', exact: true }).click();
  const selected = () => page.locator('.workspace-timeline button[aria-pressed=true]').innerText();
  const paused = await selected();
  await page.waitForTimeout(2000);
  expect(await selected()).toBe(paused);
  await play.click();
  await page.locator('.workspace-cleanup').scrollIntoViewIfNeeded();
  await expect(page.locator('.cluster-scene')).toHaveAttribute('data-motion', 'offscreen');
  const off = await selected();
  await page.waitForTimeout(2000);
  expect(await selected()).toBe(off);
  await page.locator('.cluster-scene').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.cluster-scene')).toHaveAttribute('data-motion', 'hidden');
  const hidden = await selected();
  await page.waitForTimeout(2000);
  expect(await selected()).toBe(hidden);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.cluster-scene')).toHaveAttribute('data-motion', 'reduced');
  const reduced = await selected();
  await page.waitForTimeout(2000);
  expect(await selected()).toBe(reduced);
});
