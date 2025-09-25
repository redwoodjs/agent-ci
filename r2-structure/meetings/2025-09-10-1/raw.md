08:15 Peter: On client-side navigation, redirects aren’t reloading the page anymore. The XHR auto-follows, so we miss the original 3xx and only see the final 200.
08:16 Justin: That’s fetch’s default: it auto-follows. We need to see the original redirect so the router can decide what to do.
08:18 Herman: Can we turn off the auto-follow?
08:19 Justin: Yes—set fetch’s RequestInit `redirect: "manual"`. Then it won’t auto-follow; we can detect the redirect and handle it ourselves.
08:21 Peter: So on a redirect we read `Location` and status and trigger a full navigation when needed.
08:23 Herman: Any gotchas? Browsers, cross-origin?
08:24 Justin: Cross-origin can differ, but ours are same-origin. We’ll confine this to SDK fetch paths we control.
08:27 Peter: Let’s set `redirect: "manual"` for navigation requests so we stop losing the 3xx.
08:29 Justin: I’ll wire it up and add checks to assert we see the redirect and don’t auto-follow.
