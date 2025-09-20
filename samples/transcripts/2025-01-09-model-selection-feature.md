# Transcript: Model Selection Feature

**Date:** 2025-01-09  
**Participants:** Herman, Amy, Justin  
**Topic:** Allowing model to be selected

---

**Justin:** Just added model selection to the chat interface. Users can now choose between different AI models.

**Amy:** Which models are we supporting? Just Claude variants or others too?

**Justin:** Starting with Claude 3.5 Sonnet and Claude 3 Haiku. We can add more as needed.

**Herman:** Are we storing the model preference per user or per session?

**Justin:** Per session for now. Users can switch models mid-conversation if they want.

**Amy:** That's flexible. Are we handling the case where a user switches models mid-conversation?

**Justin:** Yeah, the new model gets the full conversation history. It should work seamlessly.

**Herman:** What about performance differences between models? Are we showing any indicators?

**Amy:** Good point. We should probably show response time or some other indicator.

**Justin:** I could add a simple indicator showing which model is responding. Maybe in the message header?

**Herman:** That would be helpful. Users might want to know if they're using the faster or more capable model.

**Amy:** Are we planning to add any model-specific features? Like different system prompts?

**Justin:** That's a good idea. We could have different default prompts for different models.

**Herman:** Or maybe different capabilities. Like Haiku for quick tasks, Sonnet for complex reasoning.

**Amy:** Exactly. We could even suggest which model to use based on the task.

**Justin:** That's getting into AI territory. Maybe we should keep it simple for now.

**Herman:** Agreed. Let's get the basic model selection working first, then add the smart features.

**Amy:** Sounds good. I'll test the model switching and see how it behaves.

**Justin:** Thanks. Let me know if you find any issues with the model selection logic.
