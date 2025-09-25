09:30 Peter: We need a way for route handlers and interruptors to set HTTP status and headers directly. Passing headers in options is awkward and doesn’t cover status codes.
09:32 Justin: Let’s expose a request-scoped Response so code can do response.status = 404 and response.headers.set("Cache-Control", ...). That matches the platform and avoids extra plumbing.
09:35 Herman: How do we guarantee exactly one Response per request, shared across interruptors in order?
09:36 Justin: We create it at the start of the request, attach it to requestInfo (or similar), and pass the same instance through interruptors. The final handler returns the body/element and we send it using that Response.
09:37 Justin: Looking at MDN, there’s a typed init object, `ResponseInit`. We could just provide that to handlers and middleware.
09:39 Peter: What about callers using options.headers today?
09:40 Justin: Keep options.headers working but mark it deprecated. If both are used, the per-request Response wins. We’ll add a dev warning.
09:42 Herman: And types for Document and worker hooks? We saw mismatches around DocumentProps.
09:43 Justin: Related but separate. We’ll make sure Document and handlers receive a RequestInfo that carries the Response. We can fix the mismatch in a follow-up.
09:47 Peter: How does this behave with early returns and errors?
09:48 Justin: Interruptors still run in the same order. If one returns early, the Response already has whatever status/headers were set. On error, default to 500 unless it’s already set.
09:52 Peter: Sounds good. Let’s go with Response-on-context and deprecate headers in options.
10:05 Peter: Let’s do it.
