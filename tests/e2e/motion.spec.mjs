import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

test.use({ reducedMotion: 'no-preference' });

test.beforeEach(async ({ request }) => {
  expect(
    (await request.post('/api/progress/reset', { data: { confirm: 'RESET' } })).ok(),
  ).toBeTruthy();
});

const scene = (page, mode) => page.locator(`.spatial-flow[data-mode="${mode}"]`);
const packets = (scope) => scope.locator('.sf-lane[data-flow="active"] .sf-packet');

async function animationClock(locator) {
  return locator.evaluateAll((elements) =>
    elements.flatMap((element) =>
      element.getAnimations().map((animation) => ({
        time: Number(animation.currentTime),
        state: animation.playState,
      })),
    ),
  );
}

async function expectFrozen(locator) {
  // CSS pause resolves on the next compositor frame; wait for that pending task
  // before comparing clocks so the assertion tests a settled pause.
  await locator.evaluateAll(async (elements) => {
    await Promise.all(
      elements.flatMap((element) => element.getAnimations().map((animation) => animation.ready)),
    );
  });
  const first = await animationClock(locator);
  expect(first.length, 'At least one real CSS animation is inspected').toBeGreaterThan(0);
  expect(first.every((animation) => animation.state === 'paused')).toBeTruthy();
  // Compare actual animation clocks across time, not just the presence of a CSS class.
  await new Promise((resolve) => setTimeout(resolve, 220));
  const second = await animationClock(locator);
  expect(second).toEqual(first);
}

async function seedHistory(request, id = 'lag-growth') {
  const observations =
    id === 'insufficient-isr'
      ? ['topic', 'producer', 'replicas']
      : ['rates', 'database', 'assignment'];
  for (const choice of observations) {
    const response = await request.post(`/api/incidents/${id}`, {
      data: { action: 'observe', choice },
    });
    expect(response.ok()).toBeTruthy();
  }
}

async function capture(page, name, fullPage = true) {
  if (!process.env.E2E_SCREENSHOT_DIR) return;
  await mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, `${name}.png`), fullPage });
}

test('gallery follows log, position and commit, supports pause, reduced motion and keyboard actions', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const gallery = page.locator('.stream-gallery');
  const before = await (await request.get('/api/progress')).json();
  await expect(gallery).toHaveAttribute('data-motion', 'running');
  await expect(gallery.locator('.gallery-record')).toHaveCount(9);
  await gallery.getByRole('button', { name: 'Прочитать', exact: true }).click();
  await expect(gallery.locator('.is-read')).toHaveCount(3);
  await gallery.getByRole('button', { name: 'Рестарт', exact: true }).click();
  await expect(gallery.locator('.is-read')).toHaveCount(0);
  await gallery.getByRole('button', { name: 'Прочитать', exact: true }).click();
  await gallery.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(gallery.locator('.is-committed')).toHaveCount(3);
  await gallery.getByRole('button', { name: 'Приостановить движение журнала' }).click();
  await expect(gallery).toHaveAttribute('data-motion', 'paused');
  await gallery.getByRole('button', { name: 'Записать', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(gallery.locator('.gallery-record')).toHaveCount(10);
  expect(
    await gallery.evaluate(
      (e) => e.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
    ),
  ).toBe(0);
  await gallery.getByRole('button', { name: 'Включить движение журнала' }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(gallery).toHaveAttribute('data-motion', 'paused');
  await gallery.getByRole('button', { name: 'Записать', exact: true }).click();
  await expect(gallery.locator('.gallery-record')).toHaveCount(11);
  expect(await gallery.evaluate((e) => e.getAnimations({ subtree: true }).length)).toBe(0);
  await gallery.getByRole('button', { name: 'Сброс', exact: true }).click();
  await expect(gallery.locator('.gallery-record')).toHaveCount(9);
  expect(await (await request.get('/api/progress')).json()).toEqual(before);
  await capture(page, 'gallery-desktop', false);
});
test('sandbox scene follows actual record counts, read positions, commits, independent groups and reset', async ({
  page,
}) => {
  await page.goto('/#sandbox');
  const flow = scene(page, 'sandbox');
  const partition = flow.locator('.sf-partition[data-partition="0"]');
  // The teaching hash maps a, b, c to three different partitions.
  for (const key of ['a', 'b', 'c']) {
    await page.getByLabel('Ключ события', { exact: true }).fill(key);
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  }
  for (const p of await flow.locator('.sf-partition').all()) {
    await expect(p).toHaveAttribute('data-count', '1');
    await expect(p).toHaveAttribute('data-position', '0');
    await expect(p).toHaveAttribute('data-committed', '0');
  }
  await page.getByRole('button', { name: 'Прочитать пакет', exact: true }).click();
  await expect(partition).toHaveAttribute('data-position', '1');
  await expect(partition).toHaveAttribute('data-committed', '0');
  await page.getByRole('button', { name: 'Перезапустить consumer', exact: true }).click();
  await expect(partition).toHaveAttribute('data-position', '0');
  await expect(partition).toHaveAttribute('data-count', '1');
  await page.getByRole('button', { name: 'Прочитать пакет', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Повторная доставка');
  await page.getByRole('button', { name: 'Подтвердить offset', exact: true }).click();
  await expect(partition).toHaveAttribute('data-committed', '1');
  await expect(page.getByTestId('lag')).toHaveText('0');
  await page.getByLabel('Группа', { exact: true }).selectOption('analytics');
  await expect(partition).toHaveAttribute('data-position', '0');
  await expect(partition).toHaveAttribute('data-committed', '0');
  await expect(partition).toHaveAttribute('data-count', '1');
  await expect(flow.locator('.sf-lane[data-flow="active"]')).toHaveCount(0);
  await page.getByLabel('Потребителей', { exact: true }).selectOption('6');
  await expect(page.getByText('3 потребителя без партиций')).toBeVisible();
  await capture(page, 'motion-sandbox');
  await page.getByRole('button', { name: 'Заново', exact: true }).click();
  await expect(page.getByTestId('lag')).toHaveText('0');
  for (const p of await flow.locator('.sf-partition').all()) {
    await expect(p).toHaveAttribute('data-count', '0');
    await expect(p).toHaveAttribute('data-position', '0');
    await expect(p).toHaveAttribute('data-committed', '0');
  }
  await expect(flow.locator('.sf-lane[data-flow="active"]')).toHaveCount(0);
});

test('sandbox motion is finite, targets the written partition and does not add particles without bound', async ({
  page,
}) => {
  await page.goto('/#sandbox');
  const flow = scene(page, 'sandbox');
  await page.getByLabel('Ключ события', { exact: true }).fill('c');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await flow.scrollIntoViewIfNeeded();
  await expect(
    flow.locator('.sf-lane[data-flow="active"][data-edge="in"][data-partition="0"]'),
  ).toHaveCount(1);
  await expect(flow.locator('.sf-lane[data-flow="active"]:not([data-partition="0"])')).toHaveCount(
    0,
  );
  await expect(flow).toHaveAttribute('data-motion-state', 'running');
  await expect(flow.locator('.sf-lane[data-flow="active"]')).toHaveCount(0, { timeout: 6000 });
  const before = await flow.locator('*').count();
  for (let i = 0; i < 59; i++)
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByTestId('lag')).toHaveText('60');
  await expect(flow.locator('.sf-partition[data-partition="0"]')).toHaveAttribute(
    'data-count',
    '60',
  );
  expect(await flow.locator('*').count()).toBeLessThan(before + 100);
  expect(await flow.locator('.sf-packet').count()).toBeLessThanOrEqual(24);
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('максимум 60');
  await expect(page.getByTestId('lag')).toHaveText('60');
});

test('incident history stops offscreen, resumes without a catch-up jump, and pauses when requested', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 400 });
  await seedHistory(request);
  await page.goto('/#incidents');
  const flow = scene(page, 'incident');
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await flow.scrollIntoViewIfNeeded();
  await expect(flow).toHaveAttribute('data-motion-state', 'running');
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 1 из 4');
  // This case receives 200 events/s and processes only 80 events/s. Compare the
  // rendered animation timing so the slower downstream is actually visible.
  const inputDuration = await flow
    .locator('.sf-lane[data-edge="in"] .sf-packet')
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration));
  const outputDuration = await flow
    .locator('.sf-lane[data-edge="out"] .sf-packet')
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration));
  expect(outputDuration).toBeGreaterThan(inputDuration);
  // The working panels now sit side by side. Page bottom no longer guarantees
  // an offscreen scene. A short window and the real page header do, without
  // injecting spacer elements or changing the application's observer.
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await flow.evaluate((element) => element.getBoundingClientRect().top >= innerHeight)).toBe(
    true,
  );
  await expect(flow).toHaveAttribute('data-motion-state', 'offscreen');
  await expectFrozen(packets(flow));
  await new Promise((resolve) => setTimeout(resolve, 2900));
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 1 из 4');
  await flow.scrollIntoViewIfNeeded();
  await expect(flow).toHaveAttribute('data-motion-state', 'running');
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 1 из 4');
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 2 из 4', { timeout: 4000 });
  await flow.getByRole('button', { name: 'Приостановить движение', exact: true }).click();
  await expect(flow).toHaveAttribute('data-motion-state', 'paused');
  await expectFrozen(packets(flow));
  await new Promise((resolve) => setTimeout(resolve, 2900));
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 2 из 4');
});

test('reduced motion prevents autoplay and moving markers while manual history stays usable', async ({
  page,
  request,
}) => {
  await seedHistory(request);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#incidents');
  const flow = scene(page, 'incident');
  await flow.scrollIntoViewIfNeeded();
  await expect(flow).toHaveAttribute('data-motion-state', 'reduced');
  await expect(page.getByRole('button', { name: 'Воспроизвести', exact: true })).toBeDisabled();
  await expect(page.locator('.inc-motion-note')).toBeVisible();
  await page.getByRole('button', { name: 'Предыдущий кадр', exact: true }).click();
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 3 из 4');
  await new Promise((resolve) => setTimeout(resolve, 2900));
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 3 из 4');
  expect(
    await flow.evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running').length,
    ),
  ).toBe(0);
  await page.getByRole('button', { name: 'Следующий кадр', exact: true }).click();
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 4 из 4');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await flow.scrollIntoViewIfNeeded();
  await expect(flow).toHaveAttribute('data-motion-state', 'running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(flow).toHaveAttribute('data-motion-state', 'reduced');
  await expect(page.getByRole('button', { name: 'Воспроизвести', exact: true })).toBeDisabled();
});

test('visibility-change signal freezes incident playback and resumes from the same frame', async ({
  page,
  request,
}) => {
  // Headless Chromium keeps background pages visible. Inject the browser visibility
  // signal, then exercise the real listener, animation gate and history timer.
  await page.addInitScript(() => {
    window.testPageVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => window.testPageVisibility,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => window.testPageVisibility === 'hidden',
    });
  });
  await seedHistory(request);
  await page.goto('/#incidents');
  const flow = scene(page, 'incident');
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await flow.scrollIntoViewIfNeeded();
  await expect(flow).toHaveAttribute('data-motion-state', 'running');
  await page.evaluate(() => {
    window.testPageVisibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(flow).toHaveAttribute('data-motion-state', 'hidden');
  await expectFrozen(packets(flow));
  await new Promise((resolve) => setTimeout(resolve, 2900));
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 1 из 4');
  await page.evaluate(() => {
    window.testPageVisibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(flow).toHaveAttribute('data-motion-state', 'running');
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 1 из 4');
  await expect(page.locator('.inc-frame-count')).toHaveText('Кадр 2 из 4', { timeout: 4000 });
});

test('incident scene never sends records through blocked or zero-rate paths', async ({
  page,
  request,
}) => {
  await seedHistory(request, 'insufficient-isr');
  await page.goto('/#incidents');
  await page.locator('.inc-case').filter({ hasText: 'Запись отклоняется из-за ISR' }).click();
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  const flow = scene(page, 'incident');
  await flow.scrollIntoViewIfNeeded();
  await expect(flow).toHaveAttribute('data-motion-state', 'running');
  await expect(flow.locator('.sf-lane[data-edge="in"][data-flow="active"]')).toHaveCount(0);
  await expect(flow.locator('.sf-lane[data-edge="out"][data-flow="active"]')).toHaveCount(0);
  expect(
    await flow
      .locator('.sf-packet')
      .evaluateAll(
        (elements) =>
          elements
            .flatMap((element) => element.getAnimations())
            .filter((animation) => animation.playState === 'running').length,
      ),
  ).toBe(0);
});

test('320px and 375px spatial views retain controls and fit without horizontal scrolling', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['overview', 'sandbox', 'incidents']) {
      await page.goto(`/#${mode}`);
      if (mode === 'overview') {
        const gallery = page.locator('.stream-gallery');
        await gallery.scrollIntoViewIfNeeded();
        await expect(gallery).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBeTruthy();
        await gallery.getByRole('button', { name: 'Записать', exact: true }).click();
        await expect(gallery.locator('.gallery-record')).toHaveCount(10);
        await capture(page, 'gallery-' + width);
        continue;
      }
      const flow = scene(page, mode === 'incidents' ? 'incident' : mode);
      await flow.scrollIntoViewIfNeeded();
      await expect(flow).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        `${mode} at ${width}px`,
      ).toBeTruthy();
      await flow.getByRole('button', { name: 'Показать плоскую схему', exact: true }).click();
      await expect(flow).toHaveAttribute('data-view', 'flat');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        `${mode} flat at ${width}px`,
      ).toBeTruthy();
      await flow.getByRole('button', { name: 'Показать объёмную сцену', exact: true }).click();
      if (width === 375) await capture(page, `motion-${mode}-375`);
    }
  }
  expect(errors).toEqual([]);
});

test('arrivals belong to new records and never replay on viewport return', async ({ page }) => {
  await page.goto('/');
  const gallery = page.locator('.stream-gallery');
  await expect(gallery).toHaveAttribute('data-motion', 'running');
  expect(await gallery.evaluate((e) => e.getAnimations({ subtree: true }).length)).toBe(0);
  await gallery.getByRole('button', { name: 'Записать', exact: true }).click();
  await expect(gallery.locator('.is-arriving')).toHaveCount(0, { timeout: 3000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(gallery).toHaveAttribute('data-motion', 'paused');
  await gallery.scrollIntoViewIfNeeded();
  await expect(gallery).toHaveAttribute('data-motion', 'running');
  expect(await gallery.evaluate((e) => e.getAnimations({ subtree: true }).length)).toBe(0);
  await page.setViewportSize({ width: 320, height: 900 });
  const switcher = gallery.getByRole('button', { name: /^P1 ·/ });
  await switcher.click();
  await expect(gallery.locator('.gallery-partition:visible')).toHaveCount(1);
  await expect(gallery.getByRole('article', { name: 'Партиция 1', exact: true })).toBeVisible();
  await gallery.getByRole('button', { name: 'Записать', exact: true }).click();
  await gallery.getByRole('button', { name: /^P0 ·/ }).click();
  await gallery.getByRole('button', { name: /^P1 ·/ }).click();
  await expect(gallery.locator('.gallery-record.is-arriving')).toHaveCount(0);
  // Button focus/pressed transitions are intentional. Inspect the records,
  // whose arrival animations must not restart when their partition reappears.
  expect(
    await gallery
      .locator('.partition-gallery')
      .evaluate((e) => e.getAnimations({ subtree: true }).length),
  ).toBe(0);
});
