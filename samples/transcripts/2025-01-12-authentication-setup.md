# Transcript: Authentication Setup

**Date:** 2025-01-12  
**Participants:** Herman, Amy, Justin  
**Topic:** Adding better-auth and user accounts

---

**Amy:** So we're switching to better-auth for authentication. Anyone have experience with it?

**Justin:** I've used it in a side project. It's pretty straightforward, but the documentation could be better.

**Herman:** What made you choose it over other auth solutions?

**Amy:** It integrates well with RedwoodSDK and doesn't require external services. Plus it's TypeScript-first.

**Justin:** That's true. The type safety is really nice. No more guessing what the user object looks like.

**Herman:** Are we planning to support multiple auth providers? OAuth, email/password, etc.?

**Amy:** Starting with email/password, but we want to add GitHub OAuth eventually.

**Justin:** Better-auth handles OAuth pretty well. The GitHub integration should be straightforward.

**Herman:** What about session management? Are we storing sessions in the database?

**Amy:** Yeah, we're using the database for sessions. Better-auth handles the encryption and expiration automatically.

**Justin:** Good. Are we planning to add any custom user fields beyond the basics?

**Herman:** We'll probably need to add some fields for the development environment - maybe preferred editor settings, project preferences, etc.

**Amy:** Makes sense. We can add those as we need them.

**Justin:** Did you set up the logout functionality yet?

**Amy:** Yeah, just pushed that. It clears the session and redirects to the login page.

**Herman:** Are we handling session expiration gracefully?

**Amy:** Better-auth handles that automatically. It'll redirect to login when the session expires.

**Justin:** Nice. Should we add a "remember me" option for longer sessions?

**Amy:** That's a good idea. I'll add that to the backlog.

**Herman:** Overall, the auth setup looks solid. Much cleaner than what we had before.

**Justin:** Agreed. The integration with RedwoodSDK is really smooth.

**Amy:** Thanks. I'll test it thoroughly and let you know if I find any issues.
