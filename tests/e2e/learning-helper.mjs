import { expect } from '@playwright/test';
import { modules } from '../../content/curriculum.mjs';
import { incidents } from '../../content/incidents.mjs';
import { workspaceTasks } from '../../server/workspace.mjs';

export const learningIds = [
  ...modules.flatMap(({ lessons }) => lessons.map(({ id }) => `lesson/${id}`)),
  'sandbox',
  ...incidents.map(({ id }) => `incident/${id}`),
  ...workspaceTasks.map(({ id }) => `workspace/${id}`),
  'basic-lab',
];

// Older regression suites exercise the already-started practice. The dedicated
// learning-path suite deliberately does not call this helper: it tests every fresh entry.
export async function primeLearningPaths(request, baseURL = '') {
  for (const id of learningIds) {
    for (const stage of [1, 2, 3]) {
      const response = await request.post(`${baseURL}/api/learning/${encodeURIComponent(id)}`, {
        data: { stage },
      });
      expect(response.ok(), `${id}: prepare existing practice stage ${stage}`).toBeTruthy();
    }
  }
}
