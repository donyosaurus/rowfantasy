// Deploy-version marker for money/contest edge functions.
//
// The prior implementation exported a hardcoded FN_VERSION constant and set
// an `x-fn-version` header on every response. Because the constant was never
// updated by the deploy pipeline, the header always advertised the same
// value and could not detect deploy drift — a wrong drift signal is worse
// than none. We now emit an `x-fn-boot-id` header carrying a random UUID
// generated at cold-start plus the function name. It resets on every fresh
// cold boot (so drift/rotation is still observable via `curl -I`) and never
// claims to be a git sha it can't guarantee.

type Handler = (req: Request) => Response | Promise<Response>;

// Per-process boot id — stable across warm invocations, changes on cold start.
const BOOT_ID = crypto.randomUUID();
const BOOT_AT = new Date().toISOString();

export const FN_VERSION = `boot:${BOOT_ID}@${BOOT_AT}`;

// Wraps a request handler so every Response carries an `x-fn-boot-id`
// header. No logic change to the wrapped handler.
export function withFnVersion(fnName: string, handler: Handler): Handler {
  const bootHeader = `${fnName}/${BOOT_ID}@${BOOT_AT}`;
  return async (req: Request) => {
    const res = await handler(req);
    try {
      res.headers.set('x-fn-boot-id', bootHeader);
    } catch {
      const cloned = new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      cloned.headers.set('x-fn-boot-id', bootHeader);
      return cloned;
    }
    return res;
  };
}
