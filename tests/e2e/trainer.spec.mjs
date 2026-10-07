import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { modules } from '../../content/curriculum.mjs';
import { incidents } from '../../content/incidents.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/progress/reset', { data: { confirm: 'RESET' } });
  expect(response.ok()).toBeTruthy();
});
async function screenshot(page, name) {
  if (!process.env.E2E_SCREENSHOT_DIR) return;
  await mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(process.env.E2E_SCREENSHOT_DIR, `${name}.png`),
    fullPage: true,
  });
}

test('learn, make a mistake, retry, finish both assessments, persist notes and export', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Понимать потоки');
  await screenshot(page, 'overview');
  await page.getByRole('link', { name: 'Начать обучение', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Событие и журнал');
  await page.getByRole('button', { name: 'Перейти к проверке' }).click();
  const first = modules[0].lessons[0];
  const question = page.locator('.assessment').nth(0);
  const scenario = page.locator('.assessment').nth(1);
  await expect(question.getByRole('button', { name: 'Проверить ответ' })).toBeDisabled();
  await question
    .getByRole('radio')
    .nth((first.question.correctIndex + 1) % 4)
    .check();
  await question.getByRole('button', { name: 'Проверить ответ' }).click();
  await expect(question.getByRole('status')).toContainText('Пока не совсем');
  await expect(page.locator('.sidebar-progress')).toContainText('0 / 18');
  await question.getByRole('radio').nth(first.question.correctIndex).check();
  await question.getByRole('button', { name: 'Проверить ответ' }).click();
  await expect(question.getByRole('status')).toContainText('Верно');
  await scenario.getByRole('radio').nth(first.scenario.correctIndex).check();
  await scenario.getByRole('button', { name: 'Проверить ответ' }).click();
  await expect(page.getByText('Урок освоен', { exact: true })).toBeVisible();
  await expect(page.locator('.sidebar-progress')).toContainText('1 / 18');
  await page.getByRole('button', { name: 'Мои заметки' }).click();
  await page
    .getByLabel('Ваши наблюдения')
    .fill('Commit хранит следующий offset. Чтение не удаляет событие.');
  await page.getByRole('button', { name: 'Сохранить заметку' }).click();
  await expect(page.getByRole('status')).toHaveText('Заметка сохранена.');
  await page.reload();
  await expect(page.locator('.sidebar-progress')).toContainText('1 / 18');
  await page.getByRole('button', { name: 'Мои заметки' }).click();
  await expect(page.getByLabel('Ваши наблюдения')).toHaveValue(
    'Commit хранит следующий offset. Чтение не удаляет событие.',
  );
  await page.getByRole('link', { name: 'Мой прогресс', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Экспорт прогресса' }).click();
  expect((await download).suggestedFilename()).toMatch(/progress.*\.json/);
  expect(errors).toEqual([]);
});

test('model demonstrates redelivery, commit, independent groups and idle consumers', async ({
  page,
}) => {
  await page.goto('/#sandbox');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Песочница событий');
  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByTestId('lag')).toHaveText('3');
  await page.getByRole('button', { name: 'Прочитать пакет' }).click();
  await expect(page.getByTestId('lag')).toHaveText('3');
  await page.getByRole('button', { name: 'Перезапустить consumer' }).click();
  await page.getByRole('button', { name: 'Прочитать пакет' }).click();
  await expect(page.getByRole('status')).toContainText('Повторная доставка');
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Прочитать пакет' }).click();
  await page.getByRole('button', { name: 'Подтвердить offset' }).click();
  await expect(page.getByTestId('lag')).toHaveText('0');
  await expect(page.getByText('Эксперимент выполнен', { exact: true })).toBeVisible();
  await page.getByLabel('Группа', { exact: true }).selectOption('analytics');
  await expect(page.getByTestId('lag')).toHaveText('3');
  await page.getByLabel('Потребителей').selectOption('6');
  await expect(page.getByText('3 потребителя без партиций')).toBeVisible();
  await page.getByRole('button', { name: /Партиция .* offset 0/ }).click();
  await expect(page.locator('.inspector')).toContainText('order-42');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await screenshot(page, 'sandbox');
});

test('course search, empty result, keyboard navigation and unavailable Docker state', async ({
  page,
}) => {
  await page.goto('/#curriculum');
  await page.getByRole('textbox', { name: 'Найти урок' }).fill('никакогоурока');
  await expect(page.getByRole('status')).toContainText('Ничего не найдено');
  await page.getByRole('textbox', { name: 'Найти урок' }).fill('KRaft');
  await expect(page.getByRole('link', { name: /Брокеры и KRaft/ })).toBeVisible();
  await page.getByRole('link', { name: 'Лаборатория', exact: true }).click();
  await expect(page.getByText('Для практики нужен Docker Engine')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Запустить брокер', exact: true })).toBeDisabled();
  await page.goto('/');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Понимать потоки');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Перейти к содержимому' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('desktop pages pass axe WCAG 2.2 AA automated checks', async ({ page }) => {
  for (const route of [
    'overview',
    'curriculum',
    'sandbox',
    'incidents',
    'lab',
    'progress',
    'sources',
    'lesson/event-log',
  ]) {
    await page.goto(`/#${route}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      route,
    ).toEqual([]);
  }
});

test('375px navigation traps focus, closes on Escape, and pages have no horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Открыть меню' }).click();
  const dialog = page.getByRole('dialog', { name: 'Навигация' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Открыть меню' })).toBeFocused();
  for (const route of [
    'overview',
    'curriculum',
    'sandbox',
    'incidents',
    'lab',
    'progress',
    'lesson/event-log',
  ]) {
    await page.goto(`/#${route}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      route,
    ).toBeTruthy();
  }
  await page.goto('/#overview');
  await screenshot(page, 'mobile');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
});

test('all six incidents require diagnosis, correction and verification, and persist after reload', async ({
  page,
}) => {
  await page.goto('/#incidents');
  const solutions = [
    ['lag-growth', 'downstream', 'repair-downstream'],
    ['poison-pill', 'bad-record', 'quarantine'],
    ['advertised-listeners', 'advertised-address', 'correct-listeners'],
    ['insufficient-isr', 'replica-outage', 'restore-replicas'],
    ['disk-full', 'storage', 'expand-capacity'],
    ['duplicate-charge', 'split-commit', 'idempotent-reconcile'],
  ];
  for (const [id, hypothesis, fix] of solutions) {
    const incident = incidents.find((item) => item.id === id);
    await page.locator('.inc-case').filter({ hasText: incident.title }).click();
    for (const observation of incident.observations.slice(0, 2)) {
      await page.getByRole('button', { name: observation.label, exact: true }).click();
    }
    const wrong = incident.hypotheses.find((item) => item.id !== hypothesis);
    await page.getByRole('button', { name: wrong.label, exact: true }).click();
    await expect(page.locator('.inc-feedback')).toContainText('Нужно другое решение');
    await expect(page.getByText('Решение проверено и сохранено', { exact: true })).toHaveCount(0);
    await page
      .getByRole('button', {
        name: incident.hypotheses.find((item) => item.id === hypothesis).label,
        exact: true,
      })
      .click();
    if (id === 'lag-growth') {
      await page
        .getByRole('button', { name: 'Перевести offset в конец журнала', exact: true })
        .click();
      await expect(page.locator('.inc-feedback')).toContainText('ложное улучшение');
      await expect(page.getByRole('button', { name: 'Проверить восстановление' })).toHaveCount(0);
    }
    await page
      .getByRole('button', {
        name: incident.fixes.find((item) => item.id === fix).label,
        exact: true,
      })
      .click();
    await expect(page.getByText('Решение проверено и сохранено', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Проверить восстановление' }).click();
    await expect(page.getByText('Решение проверено и сохранено', { exact: true })).toBeVisible();
  }
  await page.reload();
  await expect(page.locator('.inc-model-banner')).toContainText('6 / 6 проверено');
  await expect(page.getByText('Решение проверено и сохранено', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Предыдущий кадр' }).click();
  await expect(page.locator('.inc-history-notice')).toContainText('Показан прошлый кадр');
  await page.getByRole('button', { name: 'К текущему состоянию' }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await expect(page.locator('.inc-flow')).toHaveClass(/inc-playing/);
  await expect
    .poll(() =>
      page
        .locator('.inc-pulse')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    )
    .not.toBe('none');
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(page.locator('.inc-flow')).not.toHaveClass(/inc-playing/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.inc-motion-note')).toBeVisible();
  await page.getByRole('button', { name: 'К текущему состоянию' }).click();
  await screenshot(page, 'incidents');
  await page.getByRole('button', { name: 'Повторить с начала' }).click();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.locator('.inc-model-banner')).toContainText('6 / 6 проверено');
});

test('network failure is explicit and retry recovers the course', async ({ page }) => {
  await page.route('**/api/course', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Учебный сервер временно недоступен.' }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toHaveText('Учебный сервер временно недоступен.');
  await page.unroute('**/api/course');
  await page.getByRole('button', { name: 'Повторить подключение' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Понимать потоки');
});

test('reset waits for a pending answer and cannot resurrect cleared progress', async ({
  page,
  request,
}) => {
  let releaseAnswer;
  let resets = 0;
  const held = new Promise((resolve) => {
    releaseAnswer = resolve;
  });
  await page.route('**/api/answer', async (route) => {
    await held;
    await route.continue();
  });
  await page.route('**/api/progress/reset', async (route) => {
    resets++;
    await route.continue();
  });
  await page.goto('/#lesson/event-log');
  await page.getByRole('button', { name: 'Перейти к проверке' }).click();
  await page
    .locator('.assessment')
    .first()
    .getByRole('radio')
    .nth(modules[0].lessons[0].question.correctIndex)
    .check();
  const answerStarted = page.waitForRequest('**/api/answer');
  await page
    .locator('.assessment')
    .first()
    .getByRole('button', { name: 'Проверить ответ' })
    .click();
  await answerStarted;
  await page.getByRole('link', { name: 'Мой прогресс', exact: true }).click();
  await page.getByText('Управление локальными данными', { exact: true }).click();
  await page.getByRole('button', { name: 'Сбросить прогресс' }).click();
  await page.getByRole('button', { name: 'Да, удалить' }).click();
  try {
    await expect(page.getByRole('button', { name: 'Да, удалить' })).toBeDisabled();
    // Hold the answer open across a navigation and reset to exercise the write race.
    await page.waitForTimeout(300);
    expect(resets).toBe(0);
  } finally {
    releaseAnswer();
  }
  await expect(page.getByRole('button', { name: 'Сбросить прогресс' })).toBeVisible();
  const stored = await (await request.get('/api/progress')).json();
  expect(stored.answers).toEqual({});
  expect(stored.completed).toEqual([]);
  await page.reload();
  await expect(page.locator('.sidebar-progress')).toContainText('0 / 18');
});

test('requested 390px and 1440px layouts preserve incident actions and readable flow', async ({
  page,
}) => {
  for (const width of [390, 800, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/#incidents');
    await expect(
      page.getByRole('button', { name: 'Сравнить вход, обработку и lag', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      String(width),
    ).toBeTruthy();
  }
});
