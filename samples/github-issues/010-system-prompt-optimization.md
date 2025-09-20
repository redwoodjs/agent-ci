# Issue #10: Optimize and improve system prompts for better AI behavior

**Labels:** enhancement, ai, prompts  
**Priority:** High  
**Assignee:** @justin  
**Created:** 2025-01-06

## Description

The system prompts need optimization to ensure the AI follows development guidelines correctly. Current prompts may be too complex or not specific enough.

## Current State

- Custom system prompts implemented
- AI sometimes not following development guidelines
- Prompts may be too long or complex
- No context-specific prompt variations

## Requirements

- [ ] Review and simplify current system prompts
- [ ] Create context-specific prompts for different tasks
- [ ] Test prompts with various AI models
- [ ] Add prompt versioning and A/B testing
- [ ] Document prompt best practices
- [ ] Implement prompt configuration system

## Acceptance Criteria

- AI consistently follows development guidelines
- Prompts are optimized for each model
- Context-specific prompts improve task performance
- Prompt changes can be tested and rolled back
- Documentation helps maintain prompt quality
- Users can provide feedback on prompt effectiveness

---

## Comments

**@justin** - 2025-01-06 9:00 AM  
So Peter had some issues with the system prompt. Anyone know what happened?

**@amy** - 2025-01-06 9:30 AM  
I saw the commit message. It looks like he was having trouble getting the AI to follow the system prompt correctly.

**@herman** - 2025-01-06 10:00 AM  
What kind of issues? Was the AI ignoring the prompt or behaving unexpectedly?

**@amy** - 2025-01-06 10:30 AM  
From what I can see, the AI was not following the development guidelines we set up. 🤷‍♀️

**@justin** - 2025-01-06 11:00 AM  
That's frustrating. System prompts are tricky to get right.

**@herman** - 2025-01-06 11:30 AM  
Are we using a custom system prompt or the default one?

**@amy** - 2025-01-06 12:00 PM  
Custom. We have specific guidelines for how the AI should behave in our development environment.

**@justin** - 2025-01-06 12:30 PM  
What kind of guidelines? Code style, project structure, that kind of thing?

**@amy** - 2025-01-06 1:00 PM  
Yeah, plus specific instructions about using RedwoodSDK patterns and our coding conventions. It's pretty comprehensive.

**@herman** - 2025-01-06 1:30 PM  
Maybe the prompt is too long or complex? Sometimes simpler prompts work better.

**@amy** - 2025-01-06 2:00 PM  
That's possible. We could try breaking it down into smaller, more focused prompts.

**@justin** - 2025-01-06 2:30 PM  
Or maybe we need to adjust the prompt based on the context? Different prompts for different types of tasks.

**@herman** - 2025-01-06 3:00 PM  
That's a good idea. We could have different system prompts for code generation vs. debugging vs. documentation.

**@amy** - 2025-01-06 3:30 PM  
Are we planning to make the system prompt configurable? So users can adjust it for their needs?

**@justin** - 2025-01-06 4:00 PM  
That could be useful, but we'd need to be careful not to let users break the core functionality.

**@herman** - 2025-01-06 4:30 PM  
Maybe we could have a base prompt that's always applied, plus optional user customizations.

**@amy** - 2025-01-06 5:00 PM  
That sounds like a good compromise. We maintain the core behavior but allow some flexibility.

**@justin** - 2025-01-06 5:30 PM  
Should we create a ticket to review and improve the system prompt?

**@herman** - 2025-01-06 6:00 PM  
Yeah, that's a good idea. We should probably test different approaches.

**@amy** - 2025-01-06 6:30 PM  
I'll create the ticket and we can discuss the best approach there.

**@justin** - 2025-01-06 7:00 PM  
Thanks. This is definitely something we need to get right for the user experience.
