import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { modules } from '../../content/curriculum.mjs';
import { lessonGuides } from '../../content/lesson-guides.mjs';
import { practiceGuides } from '../../content/practice-guides.mjs';

const lessons = modules.flatMap(({ lessons }) => lessons);
const practiceRoute = (id) =>
  id === 'basic-lab'
    ? 'lab/basic'
    : id.startsWith('workspace/')
      ? id.replace('workspace/', 'lab/')
      : id.startsWith('incident/')
        ? id.replace('incident/', 'incidents/')
        : id;

test.beforeEach(async ({ request }) => {
  expect(
    (await request.post('/api/progress/reset', { data: { confirm: 'RESET' } })).ok(),
  ).toBeTruthy();
});

async function firstEntry(page) {
  await expect(page.locator('.learning-stage-title')).toHaveText('1. Урок на русском');
  const stages = page.getByRole('navigation', { name: 'Порядок занятия' }).getByRole('button');
  await expect(stages).toHaveCount(4);
  await expect(stages.nth(0)).toHaveAttribute('aria-current', 'step');
  for (const index of [1, 2, 3]) await expect(stages.nth(index)).toBeDisabled();
  await expect(page.locator('.learning-mission')).toBeHidden();
}

async function completeIntroduction(page, guide) {
  await firstEntry(page);
  await expect(page.getByText(guide.problem, { exact: true })).toBeVisible();
  for (const term of guide.terms)
    await expect(page.getByText(term.meaning, { exact: true })).toBeVisible();
  await page.locator('.learning-next .primary').click();
  await expect(page.locator('.learning-stage-title')).toHaveText('2. Русская документация');
  for (const section of guide.documentation) {
    const reference = page
      .locator('.learning-reference')
      .filter({ has: page.getByRole('heading', { name: section.title, exact: true }) });
    await expect(reference.locator('code')).toHaveText(section.syntax);
    await expect(reference).toContainText(section.check);
    await expect(reference).toContainText(section.limitation);
  }
  await expect(page.getByText('(на английском языке)', { exact: true }).first()).toBeVisible();
  await page.locator('.learning-next .primary').click();
  await expect(page.locator('.learning-stage-title')).toHaveText('3. Наглядный пример');
  const example = page.getByRole('region', { name: 'Пошаговый рабочий пример' });
  await expect(example).toBeVisible();
  await expect(page.locator('.learning-next .primary')).toBeDisabled();
  const observed = new Set();
  for (const [index, step] of guide.example.steps.entries()) {
    await example.locator('.learning-example-controls button').nth(index).click();
    await expect(example.locator('.learning-frame')).toContainText(step.action);
    await expect(example.locator('.learning-frame')).toContainText(step.reason);
    await expect(example.locator('.learning-evidence')).toContainText(step.evidence);
    for (const [nodeIndex, node] of step.nodes.entries()) {
      await expect(example.locator('.learning-node').nth(nodeIndex)).toContainText(node.label);
      await expect(example.locator('.learning-node').nth(nodeIndex)).toContainText(
        String(node.value),
      );
    }
    observed.add(await example.locator('.learning-diagram').innerText());
  }
  expect(observed.size).toBeGreaterThanOrEqual(3);
  await expect(page.locator('.learning-next .primary')).toBeEnabled();
  await page.locator('.learning-next .primary').click();
  await expect(page.locator('.learning-stage-title')).toHaveText('4. Самостоятельная практика');
  await expect(page.locator('.learning-mission')).toContainText(guide.goal);
  await expect(page.locator('.learning-mission')).toContainText(guide.success);
  await expect(page.locator('.learning-transfer')).toContainText(guide.transfer);
}

test('catalogue links and every direct lesson or practice entry open Russian theory for a new learner', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#curriculum');
  for (const lesson of lessons) {
    await expect(page.locator(`.curriculum a[href="#lesson/${lesson.id}"]`)).toHaveCount(1);
  }
  for (const lesson of lessons) {
    await page.goto('/#curriculum');
    await page.locator(`a[href="#lesson/${lesson.id}"]`).click();
    await firstEntry(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(lesson.title);
    await page.reload();
    await firstEntry(page);
  }
  for (const id of Object.keys(practiceGuides)) {
    await page.goto('/#' + practiceRoute(id));
    await firstEntry(page);
    await expect(page.getByText(practiceGuides[id].problem, { exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('all 18 lessons teach before practice, explain wrong answers, allow retry and restore both mastered checks', async ({
  page,
  request,
}) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const lesson of lessons) {
    const guide = lessonGuides[lesson.id];
    await page.goto('/#lesson/' + lesson.id);
    await completeIntroduction(page, guide);
    for (const [index, kind] of ['question', 'scenario'].entries()) {
      const assessment = page.locator('.assessment').nth(index);
      const wrong = (lesson[kind].correctIndex + 1) % lesson[kind].options.length;
      await assessment.getByRole('radio').nth(wrong).check();
      await assessment.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
      await expect(assessment.getByRole('status')).toContainText(
        guide.feedback[kind][wrong].explanation,
      );
      await expect(assessment.getByRole('status')).toContainText(guide.feedback[kind][wrong].hint);
      await page
        .getByRole('navigation', { name: 'Порядок занятия' })
        .getByRole('button')
        .nth(0)
        .click();
      await page.getByRole('button', { name: 'Продолжить начатую практику', exact: true }).click();
      await expect(assessment.getByRole('radio').nth(wrong)).toBeChecked();
      await assessment.getByRole('radio').nth(lesson[kind].correctIndex).check();
      await assessment.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
      await expect(assessment.getByRole('status')).toContainText('Верно');
      await expect(assessment.getByRole('status')).toContainText(
        guide.feedback[kind][lesson[kind].correctIndex].explanation,
      );
    }
    await expect(page.getByText('Урок освоен', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator('.learning-stage-title')).toHaveText('4. Самостоятельная практика');
    await expect(page.getByText('Урок освоен', { exact: true })).toBeVisible();
    await expect(
      page.locator('.assessment').first().getByRole('radio').nth(lesson.question.correctIndex),
    ).toBeChecked();
  }
  const progress = await (await request.get('/api/progress')).json();
  expect(progress.completed.sort()).toEqual(lessons.map(({ id }) => id).sort());
  for (const lesson of lessons) {
    for (const kind of ['question', 'scenario']) {
      expect(progress.answers[lesson.id][kind]).toMatchObject({ correct: true, attempts: 2 });
    }
  }
  expect(errors).toEqual([]);
});

test('all 14 practice entries provide their own Russian reference and visual example then resume the saved practice stage', async ({
  page,
}) => {
  test.setTimeout(180000);
  for (const [id, guide] of Object.entries(practiceGuides)) {
    await page.goto('/#' + practiceRoute(id));
    await completeIntroduction(page, guide);
    await page.reload();
    await expect(page.locator('.learning-stage-title')).toHaveText('4. Самостоятельная практика');
    await page
      .getByRole('navigation', { name: 'Порядок занятия' })
      .getByRole('button')
      .nth(1)
      .click();
    await expect(page.locator('.learning-stage-title')).toHaveText('2. Русская документация');
    await page.getByRole('button', { name: 'Продолжить начатую практику', exact: true }).click();
    await expect(page.locator('.learning-stage-title')).toHaveText('4. Самостоятельная практика');
  }
});

test('new learning stages support keyboard, reduced motion, Russian labels and narrow screens', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  for (const width of [390, 305]) {
    await request.post('/api/progress/reset', { data: { confirm: 'RESET' } });
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/#lesson/event-log');
    // Resetting the API does not remount a page when goto only repeats its hash.
    // Start each viewport with fresh client state as well as a fresh database.
    await page.reload();
    await firstEntry(page);
    for (const stage of [0, 1, 2]) {
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      const violations = (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations;
      expect(
        violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
      ).toEqual([]);
      if (stage < 2) {
        await page.locator('.learning-next .primary').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.learning-stage-title')).toHaveText(
          `${stage + 2}. ${stage === 0 ? 'Русская документация' : 'Наглядный пример'}`,
        );
        await expect(page.locator('.learning-stage-title')).toBeFocused();
      }
    }
    const example = page.getByRole('region', { name: 'Пошаговый рабочий пример' });
    await expect(
      example.getByRole('button', { name: 'Воспроизвести пример', exact: true }),
    ).toBeDisabled();
    const before = await example.locator('.learning-diagram').innerText();
    await example.getByRole('button', { name: 'Следующий шаг', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(example.locator('.learning-frame h4')).toContainText('2.');
    expect(await example.locator('.learning-diagram').innerText()).not.toBe(before);
    expect(
      await example
        .locator('.learning-node')
        .evaluateAll(
          (nodes) =>
            nodes
              .flatMap((node) => node.getAnimations())
              .filter((animation) => animation.playState === 'running').length,
        ),
    ).toBe(0);
  }
});

test('sandbox drafts and the basic-lab attempt journal survive rereading and reload, including failure then retry', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/#sandbox');
  await completeIntroduction(page, practiceGuides.sandbox);
  await page.getByLabel('Ключ события', { exact: true }).fill(' ');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.sandbox-workstation')).toContainText('Ключ пуст');
  await expect(page.locator('.sandbox-workstation')).toContainText('повторите отправку');
  await page.getByLabel('Ключ события', { exact: true }).fill('order-73');
  await page.getByLabel('Значение', { exact: true }).fill('Заказ 73 оплачен');
  for (let index = 0; index < 3; index++)
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByRole('button', { name: 'Прочитать пакет', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Ключ события', { exact: true })).toHaveValue('order-73');
  await expect(page.getByLabel('Значение', { exact: true })).toHaveValue('Заказ 73 оплачен');
  await expect(page.getByTestId('lag')).toHaveText('3');
  await page.getByRole('button', { name: 'Перезапустить consumer', exact: true }).click();
  await page.getByRole('button', { name: 'Прочитать пакет', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Повторная доставка');
  for (let index = 0; index < 2; index++)
    await page.getByRole('button', { name: 'Прочитать пакет', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить offset', exact: true }).click();
  await expect(page.getByTestId('lag')).toHaveText('0');
  await expect(page.getByText('Эксперимент выполнен', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Порядок занятия' })
    .getByRole('button')
    .nth(0)
    .click();
  await page.getByRole('button', { name: 'Продолжить начатую практику', exact: true }).click();
  await expect(page.getByTestId('lag')).toHaveText('0');
  await page.reload();
  await expect(page.getByText('Эксперимент выполнен', { exact: true })).toBeVisible();

  let topicAttempts = 0;
  // This fixture checks UI persistence only; it does not assert a live Kafka result.
  await page.route('**/api/lab', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { available: true, running: true, status: 'ready' } });
      return;
    }
    const action = route.request().postDataJSON().action;
    expect(action).toBe('topic');
    topicAttempts += 1;
    await route.fulfill({
      status: topicAttempts === 1 ? 503 : 200,
      json:
        topicAttempts === 1
          ? {
              ok: false,
              output:
                'Проверочный ответ: брокер пока недоступен. Обновите состояние и повторите создание топика.',
            }
          : { ok: true, output: 'Проверочный ответ: топик orders создан, partitions=3.' },
    });
  });
  await page.goto('/#lab/basic');
  await completeIntroduction(page, practiceGuides['basic-lab']);
  await page.getByRole('button', { name: 'Создать топик orders', exact: true }).click();
  const output = page.getByRole('complementary', { name: 'Вывод и доказательства' });
  await expect(output).toContainText('брокер пока недоступен');
  await expect(output).toContainText('повторите создание');
  await page.getByRole('button', { name: 'Создать топик orders', exact: true }).click();
  await expect(output).toContainText('partitions=3');
  await expect(page.locator('.lab-step.complete')).toHaveCount(1);
  await page.reload();
  await expect(output).toContainText('partitions=3');
  await expect(page.locator('.lab-step.complete')).toHaveCount(1);
  await expect(page.getByText(/Отметки шагов относятся к сохранённой попытке/)).toBeVisible();
  expect(topicAttempts).toBe(2);
});
