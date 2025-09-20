# Issue #7: Add model-specific system prompts and capabilities

**Labels:** enhancement, ai, prompts  
**Priority:** Medium  
**Assignee:** @justin  
**Created:** 2025-01-09

## Description

Users can now select between different AI models, but we should add model-specific system prompts and capabilities to optimize the experience for each model's strengths.

## Current State

- Model selection working (Claude 3.5 Sonnet and Claude 3 Haiku)
- Generic system prompt for all models
- No model-specific optimizations

## Requirements

- [ ] Create model-specific system prompts
- [ ] Add model capability indicators in UI
- [ ] Implement smart model suggestions based on task type
- [ ] Add model-specific settings and preferences
- [ ] Document model differences for users
- [ ] Test model-specific prompts thoroughly

## Acceptance Criteria

- Each model has optimized system prompts
- Users understand the differences between models
- System suggests appropriate models for different tasks
- Model-specific settings are preserved per user
- All models work reliably with their custom prompts

---

## Comments

**@amy** - 2025-01-09 10:00 AM  
Are we planning to add any model-specific features? Like different system prompts?

**@justin** - 2025-01-09 10:30 AM  
That's a good idea. We could have different default prompts for different models.

**@herman** - 2025-01-09 11:00 AM  
Or maybe different capabilities. Like Haiku for quick tasks, Sonnet for complex reasoning.

**@amy** - 2025-01-09 11:30 AM  
Exactly. We could even suggest which model to use based on the task. 🤖

**@justin** - 2025-01-09 12:00 PM  
That's getting into AI territory. Maybe we should keep it simple for now.

**@herman** - 2025-01-09 12:30 PM  
Agreed. Let's get the basic model selection working first, then add the smart features.

**@amy** - 2025-01-09 1:00 PM  
What about performance differences between models? Are we showing any indicators?

**@justin** - 2025-01-09 1:30 PM  
Good point. We should probably show response time or some other indicator.

**@herman** - 2025-01-09 2:00 PM  
I could add a simple indicator showing which model is responding. Maybe in the message header?

**@amy** - 2025-01-09 2:30 PM  
That would be helpful. Users might want to know if they're using the faster or more capable model.

**@justin** - 2025-01-09 3:00 PM  
I'll start working on the model-specific prompts and let you know how it goes.

**@herman** - 2025-01-09 3:30 PM  
Sounds good. I'll test the model switching and see how it behaves.

**@amy** - 2025-01-09 4:00 PM  
Thanks. Let me know if you find any issues with the model selection logic.
