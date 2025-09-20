# Transcript: Worker Configuration

**Date:** 2025-01-05  
**Participants:** Herman, Amy, Justin  
**Topic:** Worker configuration and environment variables

---

**Justin:** Just cleaned up the worker configuration. Removed some unused environment variables and added proper configuration.

**Amy:** What kind of environment variables were we not using?

**Justin:** There were some old ones from when we were using different services. Plus some that were set but never referenced.

**Herman:** Are we using environment variables for the AI API keys and other sensitive data?

**Justin:** Yeah, all the sensitive stuff is in environment variables. The worker config just handles the non-sensitive configuration.

**Amy:** What about the Vite config changes? I saw you updated the alias resolution.

**Justin:** That was to fix the @opencode-ai/sdk/client import. The alias wasn't resolving correctly in the worker.

**Herman:** Are we planning to add more SDK integrations? The OpenCode one seems pretty specific.

**Justin:** Maybe. It depends on what features we want to add. The SDK makes it easy to integrate with their services.

**Amy:** What services are we using from OpenCode? Just the AI features?

**Justin:** For now, yeah. But they have other developer tools that might be useful.

**Herman:** Are we planning to make the worker configuration more dynamic? Like configurable at runtime?

**Amy:** That could be useful for different environments. Dev, staging, production, etc.

**Justin:** Good idea. We could have different configs for different deployment environments.

**Herman:** Are we using any worker-specific features? Like Durable Objects or KV storage?

**Justin:** Not yet, but we're planning to use Durable Objects for session storage.

**Amy:** That would be better than storing sessions in the database. More scalable.

**Justin:** Exactly. Plus it keeps the session data closer to the worker.

**Herman:** Sounds good. The worker configuration looks much cleaner now.

**Amy:** Agreed. Thanks for cleaning that up, Justin.

**Justin:** No problem. Let me know if you find any other configuration issues.
