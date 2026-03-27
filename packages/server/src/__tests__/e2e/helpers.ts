export type RequestDispatch = (request: Request) => Promise<Response>;

export function createFetchDispatchHarness(
  origin: string,
  dispatch: RequestDispatch,
): { close: () => Promise<void> } {
  const originalFetch = globalThis.fetch;

  const fetchDispatcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request
        ? input
        : (() => {
            try {
              return new Request(String(input), init);
            } catch {
              return new Request(new URL(String(input), origin), init);
            }
          })();

    const requestUrl = new URL(request.url);
    if (requestUrl.origin === origin) {
      return dispatch(request);
    }

    return originalFetch(input, init) as Promise<Response>;
  };

  globalThis.fetch = fetchDispatcher as typeof globalThis.fetch;

  return {
    close: async () => {
      globalThis.fetch = originalFetch;
    },
  };
}
