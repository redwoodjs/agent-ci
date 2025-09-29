**09:28 Peter:** Morning, everyone. How’s it going?  
**09:28 Herman:** Doing well, thanks. Just trying to stay on top of my inbox.  
**09:29 Justin:** Same here. Feels like one of those weeks already.  
**09:30 Peter:** Yeah, tell me about it. Anyway, quick thing before we get into anything else—last night I was working on one of the routes and it struck me: we don’t have a good way for route handlers or interruptors to set HTTP status and headers directly. Right now we pass headers in the options object, which feels a bit awkward. And it doesn’t even cover status codes properly.  
**09:32 Justin:** Right, that’s been bugging me too. What if we expose a request-scoped `Response`? Then code could just do `response.status = 404` and `response.headers.set("Cache-Control", ...)`. That lines up with the platform and saves us from inventing extra plumbing.  
**09:35 Herman:** Okay, but how do we make sure there’s exactly one `Response` per request? We need it shared across interruptors in the right order.  
**09:36 Justin:** My thought: create it at the start of the request, attach it to something like `requestInfo`, and pass that same instance through all interruptors. Then the final handler just returns the body or element, and we send it through that `Response`.  
**09:37 Justin:** Oh, and looking at MDN—they already define a typed init object, `ResponseInit`. We could just use that for handlers and middleware.  
**09:39 Peter:** Makes sense. What about the people who are still using `options.headers` today?  
**09:40 Justin:** We keep it working, but mark it as deprecated. If both are set, the per-request `Response` takes precedence. We could even add a dev warning so folks know to migrate.  
**09:42 Herman:** While we’re on the subject, what about the type mismatches we saw with `DocumentProps` and the worker hooks?  
**09:43 Justin:** That’s related, but a bit separate. We’ll make sure both Document and handlers receive a `RequestInfo` that carries the `Response`. The type mismatch we can fix in a follow-up PR.  
**09:47 Peter:** Cool. And how does this behave if someone does an early return or we hit an error?  
**09:48 Justin:** Interruptors still run in the same order. If one returns early, the `Response` already has whatever status or headers were set. And on error we just default to 500, unless it’s already set.  
**09:52 Peter:** Perfect. So let’s go ahead with the `Response` on context and deprecate `options.headers`.  
**10:05 Peter:** Alright, sounds like we have consensus. Let’s do it. Anything else before we wrap up?  
**10:06 Herman:** Nope, that covers it for me.  
**10:06 Justin:** Same here.  
**10:07 Peter:** Great—thanks, everyone. Have a good one.
