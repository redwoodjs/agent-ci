# Transcript: System Prompt Issues

**Date:** 2025-01-06  
**Participants:** Herman, Amy, Justin  
**Topic:** System prompt problems and fixes

---

**Justin:** So Peter had some issues with the system prompt. Anyone know what happened?

**Amy:** I saw the commit message. It looks like he was having trouble getting the AI to follow the system prompt correctly.

**Herman:** What kind of issues? Was the AI ignoring the prompt or behaving unexpectedly?

**Amy:** From what I can see, the AI was not following the development guidelines we set up.

**Justin:** That's frustrating. System prompts are tricky to get right.

**Herman:** Are we using a custom system prompt or the default one?

**Amy:** Custom. We have specific guidelines for how the AI should behave in our development environment.

**Justin:** What kind of guidelines? Code style, project structure, that kind of thing?

**Amy:** Yeah, plus specific instructions about using RedwoodSDK patterns and our coding conventions.

**Herman:** Maybe the prompt is too long or complex? Sometimes simpler prompts work better.

**Amy:** That's possible. We could try breaking it down into smaller, more focused prompts.

**Justin:** Or maybe we need to adjust the prompt based on the context? Different prompts for different types of tasks.

**Herman:** That's a good idea. We could have different system prompts for code generation vs. debugging vs. documentation.

**Amy:** Are we planning to make the system prompt configurable? So users can adjust it for their needs?

**Justin:** That could be useful, but we'd need to be careful not to let users break the core functionality.

**Herman:** Maybe we could have a base prompt that's always applied, plus optional user customizations.

**Amy:** That sounds like a good compromise. We maintain the core behavior but allow some flexibility.

**Justin:** Should we create a ticket to review and improve the system prompt?

**Herman:** Yeah, that's a good idea. We should probably test different approaches.

**Amy:** I'll create the ticket and we can discuss the best approach there.

**Justin:** Thanks. This is definitely something we need to get right for the user experience.
