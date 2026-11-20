const workerAttempts = 2;

// A recreated worker container leaves the API holding a dead socket; one bounded
// retry re-resolves it. The body is already serialized, so retrying is safe.
export async function workerFetch(
  url: string,
  init: RequestInit = {},
  attempts: number = workerAttempts,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
  }
}
