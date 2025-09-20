# Transcript: RedwoodSDK v1.0 Upgrade

**Date:** 2025-01-11  
**Participants:** Herman, Amy, Justin  
**Topic:** Upgrading to RedwoodSDK v1.0

---

**Justin:** So we're upgrading to RedwoodSDK v1.0. Anyone know what breaking changes we need to watch out for?

**Herman:** I looked through the changelog. The main changes are in the routing system and some API updates.

**Amy:** What kind of routing changes?

**Herman:** They've simplified the route definition syntax. The old way with nested objects is deprecated.

**Justin:** That's going to require updating all our route files. How many do we have?

**Amy:** Let me check... looks like we have routes in the pages directory and some in the app directory.

**Herman:** The good news is they provide a migration script. It should handle most of the changes automatically.

**Justin:** Did you run the migration script yet?

**Herman:** Not yet. I wanted to discuss it first in case there are any custom routes that need special handling.

**Amy:** What about the API changes? Anything that affects our existing code?

**Herman:** The main change is in how we handle request context. The `ctx` object structure has changed slightly.

**Justin:** That could affect our interruptors and middleware. We should test those thoroughly.

**Amy:** Are there any new features we should take advantage of?

**Herman:** They've added better TypeScript support and some new utility functions. Nothing critical, but nice to have.

**Justin:** Should we upgrade in a separate branch first to test everything?

**Amy:** That's a good idea. We can test all the main flows before merging to main.

**Herman:** Agreed. I'll create a branch and run the migration script there.

**Justin:** Let me know when it's ready and I'll help test it.

**Amy:** Same here. I'll focus on testing the authentication flows since those are critical.

**Herman:** Sounds good. I'll start the upgrade process and keep you posted on any issues.
