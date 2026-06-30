// Shared deploy-version marker for money/contest edge functions.
// Value format: <repo-git-sha>+<deploy-timestamp>
// Updated on each deploy so `curl -I` can detect frozen-deploy drift.
export const FN_VERSION = '03c5cc8+2026-06-30T05:39:31Z';

type Handler = (req: Request) => Response | Promise<Response>;

// Wraps a request handler so every Response (including errors and OPTIONS)
// carries an `x-fn-version` header. No logic change to the wrapped handler.
export function withFnVersion(fnName: string, handler: Handler): Handler {
  const version = `${FN_VERSION}/${fnName}`;
  return async (req: Request) => {
    const res = await handler(req);
    try {
      res.headers.set('x-fn-version', version);
    } catch {
      // headers immutable (rare) — return a clone with the header set
      const cloned = new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      cloned.headers.set('x-fn-version', version);
      return cloned;
    }
    return res;
  };
}
