let mutations: Promise<void> = Promise.resolve();
export function api<T>(path: string, body?: unknown): Promise<T> {
  // Serialize local learning writes so a reset cannot overtake an earlier answer.
  if (body !== undefined) {
    const request = mutations.then(() => requestApi<T>(path, body));
    mutations = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }
  return mutations.then(() => requestApi<T>(path));
}
async function requestApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? 'Не удалось выполнить запрос. Попробуйте ещё раз.');
  return data as T;
}
export function go(route: string) {
  window.location.hash = route;
}
