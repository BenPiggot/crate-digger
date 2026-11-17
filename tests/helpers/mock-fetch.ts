/**
 * A tiny respx-style fetch mock. Routes match on the URL path (exact string or
 * regex); unmatched requests throw so tests never reach the network.
 */

type Handler = (url: URL, callIndex: number) => Response | Promise<Response>;

export interface Route {
  /** URLs of the requests this route answered, in order. */
  calls: URL[];
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

export function mockFetch() {
  const routes: (Route & { match: (url: URL) => boolean; handler: Handler })[] = [];

  const fetch = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const route = routes.find((r) => r.match(url));
    if (!route) return Promise.reject(new Error(`Unmocked request: ${url.href}`));
    route.calls.push(url);
    return Promise.resolve(route.handler(url, route.calls.length - 1));
  };

  /** Answer requests to `path` with `handler`, or with `body` as JSON every time. */
  function on(path: string | RegExp, handlerOrBody: Handler | Record<string, unknown>): Route {
    const handler: Handler =
      typeof handlerOrBody === "function" ? handlerOrBody : () => json(handlerOrBody);
    const route = {
      calls: [] as URL[],
      match: (url: URL) =>
        typeof path === "string" ? url.pathname === path : path.test(url.pathname),
      handler,
    };
    routes.push(route);
    return route;
  }

  return { fetch: fetch, on };
}
