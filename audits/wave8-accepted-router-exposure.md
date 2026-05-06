# Wave 8 — Accepted Residual: `@remix-run/router` Open-Redirect (GHSA-2w69-qvjg-hvjx)

**Status:** Accepted residual, mitigated at consumer layer.
**Severity (advisory):** HIGH
**Affected package:** `@remix-run/router <=1.23.1` (transitive via `react-router-dom@6.30.1`)
**Fixed in:** `@remix-run/router@1.23.2+`, shipped only with `react-router-dom@7.x`

## Why we accept the residual

The patch is only available behind a **major version bump** of `react-router-dom`
(6.x → 7.x), which requires migrating to the Data Router API and is a
breaking change to `<Routes>` semantics. That work is scheduled as a separate
Tier 3 prompt with its own routing test plan; shipping it inside a P0 hotfix
is unsafe.

## Compensating controls (in effect today)

### 1. Consumer-side path guard for `from` redirects
The only dynamic router sinks in the app are the post-login redirects in
`src/pages/Login.tsx` and `src/pages/Signup.tsx`, which read
`location.state.from`. Both now sanitize the value before calling
`navigate(...)`:

```ts
const rawFrom = (location.state as any)?.from;
const from =
  typeof rawFrom === 'string' &&
  rawFrom.startsWith('/') &&
  !rawFrom.startsWith('//') &&
  !rawFrom.includes(':') &&
  !rawFrom.toLowerCase().startsWith('javascript:')
    ? rawFrom
    : '/';
navigate(from);
```

Rejected inputs:
- non-string values
- strings not starting with `/`
- protocol-relative URLs (`//evil.com`)
- any string containing `:` (catches `javascript:`, `http:`, custom schemes)
- explicit `javascript:` prefix (defense in depth)

This closes the open-redirect-XSS sink at the application layer regardless of
router internals.

### 2. CSP `frame-ancestors 'none'`
`index.html` already sets `frame-ancestors 'none'` in the page CSP, which
limits the redirect-to-iframe attack class.

### 3. Static-only `<Navigate>` and `useNavigate(...)` callsites elsewhere
All other `navigate(...)` and `<Navigate to=...>` callsites in `src/` use
static literal paths derived from compile-time constants (route IDs,
`location.pathname`, etc.) — no other dynamic destinations are sourced from
`location.state` or query params.

## Verification checklist

When touching routing code, re-verify:

```bash
rg -n "navigate\(" src/
rg -n "<Navigate " src/
```

Every dynamic destination must either:
1. Pass the same path guard above, **or**
2. Use a static literal route.

## Remediation owner

Scheduled for the **router-7 migration** Tier 3 prompt. After that lands,
this document and the consumer-side guards can be reviewed for removal.

## Other Wave 8 fixes

The following transitive vulnerabilities are now resolved via `overrides`
in `package.json`:
- `flatted >= 3.3.3` (HIGH — unbounded recursion DoS + prototype pollution)
- `brace-expansion >= 2.0.2` (MODERATE — ReDoS)
- `glob >= 10.4.5` (HIGH — already satisfied by lockfile, override pinned for safety)
- `esbuild >= 0.25.0` (MODERATE — already satisfied by lockfile)
- `ajv >= 6.12.3` (MODERATE — already satisfied by lockfile)
- `yaml >= 2.4.2` (MODERATE — already satisfied by lockfile)
