import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../server/app.mjs';
import { createStore } from '../../server/store.mjs';
import { createWorkspaceRunner } from '../../server/workspace.mjs';

test('real browser to API to Kafka: edit, failed verification, commit, recovery and saved evidence', async ({
  page,
}) => {
  test.skip(
    process.env.RUN_WORKSPACE_BROWSER !== '1',
    'Explicit live run under shared hardware lock only.',
  );
  test.setTimeout(600000);
  const directory = mkdtempSync(join(tmpdir(), 'kafka-real-browser-'));
  const store = createStore(directory);
  const runner = createWorkspaceRunner({ store, testMode: true, hardwareLock: false });
  const app = createApp({ dataDir: directory, workspaceRunner: runner });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  async function click(name, action) {
    const completed = page.waitForResponse(
      (r) =>
        r.url() === `${url}/api/workspace` &&
        r.request().method() === 'POST' &&
        r.request().postDataJSON().action === action,
      { timeout: 300000 },
    );
    await page.getByRole('button', { name, exact: true }).click();
    const response = await completed;
    const result = await response.json();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result;
  }
  try {
    await page.goto(`${url}/#lab`);
    await expect(page.getByLabel('JSON-рецепт')).toBeVisible();
    await page.getByRole('button', { name: /Брокер недоступен/ }).click();
    await page.getByRole('button', { name: '1. Подготовить новую попытку' }).click();
    await click('Подтвердить сброс', 'prepare');
    await click('Отключить broker 3', 'fault');
    await expect(page.locator('.cluster-rack.is-down')).toHaveCount(1);
    const editor = page.getByLabel('JSON-рецепт');
    const recipe = JSON.parse(await editor.inputValue());
    recipe.consumer.maxRecords = 3;
    recipe.records[0].value = 'Изменённый заказ из браузера';
    await editor.fill(JSON.stringify(recipe, null, 2));
    await click('2. Записать из рецепта', 'produce');
    await click('3. Прочитать группой', 'consume');
    const rejected = await click('Проверить результат', 'verify');
    expect(rejected.state.verified).toBe(false);
    await expect(page.locator('.workspace-result')).not.toContainText('Результат проверен');
    await click('Восстановить broker 3', 'recover');
    await expect(page.locator('.cluster-rack.is-down')).toHaveCount(0);
    recipe.consumer.commit = true;
    await editor.fill(JSON.stringify(recipe, null, 2));
    await click('3. Прочитать группой', 'consume');
    const checked = await click('Проверить результат', 'verify');
    expect(checked.state.verified).toBe(true);
    await page.reload();
    await expect(
      page.locator('.workspace-task').filter({ hasText: 'Брокер недоступен' }),
    ).toBeVisible();
    await page.getByRole('button', { name: /Брокер недоступен/ }).click();
    await expect(page.locator('.workspace-result')).toContainText('Результат проверен');
    const screenshots = process.env.KAFKA_QA_DIR
      ? resolve(process.env.KAFKA_QA_DIR)
      : join(directory, 'screenshots');
    mkdirSync(screenshots, { recursive: true });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1050 });
      await page.locator('.cluster-scene').scrollIntoViewIfNeeded();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: join(screenshots, `workspace-real-${width}.png`),
        fullPage: true,
      });
    }
    const replay = await click('3. Прочитать группой', 'consume');
    expect(replay.event.result.records).toHaveLength(0);
    expect((await click('Проверить результат', 'verify')).state.verified).toBe(true);
    expect(errors).toEqual([]);
    mkdirSync('data', { recursive: true });
    writeFileSync(
      'data/workspace-browser-evidence.json',
      JSON.stringify(
        {
          testedAt: new Date().toISOString(),
          viewports: [320, 390, 768, 1440],
          consoleErrors: errors,
          state: store.workspace('recovery'),
        },
        null,
        2,
      ),
    );
  } finally {
    const cleanup = await runner.execute('recovery', 'stop');
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.locals.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    expect(cleanup.ok, cleanup.error).toBe(true);
  }
});
