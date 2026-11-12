import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('three causal models reject shortcuts, preserve effects and require explicit verification', async ({
  page,
}) => {
  await page.goto('/#lab');
  for (const title of ['Poison pill и карантин', 'ISR и отказ записи', 'Утраченная история']) {
    await page.locator('.workspace-task').filter({ hasText: title }).click();
    await expect(
      page.getByRole('button', { name: '3. Прочитать группой', exact: true }),
    ).toHaveCount(0);
    const model = page.getByRole('region', { name: 'Разбор причины и решения' });
    await model.getByRole('button', { name: 'Проверить модель', exact: true }).click();
    await expect(model.getByRole('status')).not.toContainText('Модель проверена');
    await model.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
    await model.getByRole('button', { name: 'Исследовать', exact: true }).click();
    const choices = model.locator('.practice-decision button');
    await choices.nth(0).click();
    await model.getByRole('button', { name: 'Проверить модель', exact: true }).click();
    await expect(model.getByRole('status')).toContainText('Проверка не пройдена');
    await choices.nth(1).click();
    await model.getByRole('button', { name: 'Проверить модель', exact: true }).click();
    await expect(model.getByRole('status')).toContainText('Проверка не пройдена');
    await choices.nth(2).click();
    await model.getByRole('button', { name: 'Проверить модель', exact: true }).click();
    await expect(model.getByRole('status')).toContainText('Модель проверена');
    const records = await model.locator('.practice-evidence').innerText();
    await choices.nth(1).click();
    expect(await model.locator('.practice-evidence').innerText()).toBe(records);
    const violations = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze())
      .violations;
    expect(violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
    await model.getByRole('button', { name: 'Сброс модели', exact: true }).click();
    await expect(model.getByRole('status')).toContainText('Три события сохранены');
  }
});

test('featured incidents open the exact named practice', async ({ page }) => {
  for (const [id, title] of [
    ['poison-quarantine', 'Poison pill и карантин'],
    ['isr-write-gate', 'ISR и отказ записи'],
    ['retention-gap', 'Утраченная история'],
  ]) {
    await page.goto('/');
    await page.locator('.field-notes a[href="#lab/' + id + '"]').click();
    await expect(page.locator('.workspace-brief h2')).toHaveText(title);
    await expect(page.getByRole('region', { name: 'Разбор причины и решения' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.workspace-brief h2')).toHaveText(title);
  }
});
