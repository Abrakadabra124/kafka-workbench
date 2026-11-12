import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('course search preserves the complete chapter summary', async ({ page }) => {
  await page.goto('/#curriculum');
  const summary = await page.locator('.chapter-meta').first().innerText();
  await page.getByRole('textbox', { name: 'Найти урок' }).fill('KRaft');
  await expect(page.locator('.chapter-meta')).toHaveCount(1);
  await expect(page.locator('.chapter-meta')).toHaveText(summary);
});

test('working interiors fit desktop, tablet and narrow phones including lesson tabs', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // A 320px window with a classic 15px scrollbar leaves 305px for content.
  // Cover that available width even on CI browsers with overlay scrollbars.
  for (const width of [1440, 768, 390, 320, 305]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of [
      'curriculum',
      'sandbox',
      'incidents',
      'lab/recovery',
      'lab/retention-gap',
      'progress',
      'sources',
      'lesson/event-log',
    ]) {
      await page.goto('/#' + route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (route.startsWith('lab')) await expect(page.locator('.workspace-brief')).toBeVisible();
      if (route === 'incidents') await expect(page.locator('.inc-case-heading')).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        `${route} at ${width}`,
      ).toBe(true);
    }
    for (const name of ['Проверить себя', 'Мои заметки', 'Разобраться']) {
      await page.getByRole('button', { name, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        `${name} at ${width}`,
      ).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});

test('assessment, notes and basic lab remain accessible, with an explicit focus jump to output', async ({
  page,
}) => {
  await page.goto('/#lesson/event-log');
  for (const name of ['Проверить себя', 'Мои заметки']) {
    await page.getByRole('button', { name, exact: true }).click();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/#lab');
  await page.getByRole('button', { name: 'Базовая лаборатория', exact: true }).click();
  await page.getByRole('button', { name: 'Посмотреть вывод', exact: true }).first().click();
  await expect(page.getByRole('complementary', { name: 'Вывод и доказательства' })).toBeFocused();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
});
