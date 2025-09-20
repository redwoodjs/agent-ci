# Transcript: RAG Experiment Discussion

**Date:** 2025-01-15  
**Participants:** Herman, Amy, Justin  
**Topic:** First RAG experiment with transcripts

---

**Herman:** So Peter just pushed the first RAG experiment. Anyone looked at the transcript implementation yet?

**Amy:** Yeah, I saw the commit. It's pretty basic right now - just storing transcripts in the database. But the idea of using conversation history for RAG is interesting.

**Justin:** I'm curious about the performance implications. Are we planning to index all these transcripts for search?

**Herman:** That's the question, right? If we're storing every conversation, we need to think about how to make them searchable without killing performance.

**Amy:** Maybe we could start with a simple keyword search and see how it performs? We could always add more sophisticated indexing later.

**Justin:** True. But we should probably set up some limits - maybe only index the last N conversations per user, or conversations from the last 30 days.

**Herman:** Good point. We don't want to be storing and indexing everything forever. That could get expensive fast.

**Amy:** Should we add a cleanup job to remove old transcripts? Or maybe compress them somehow?

**Justin:** Cleanup job sounds good. We could also consider storing just the important parts - maybe extract key decisions or code snippets rather than the full conversation.

**Herman:** That's smart. We could use the AI to summarize conversations and store both the summary and the full transcript.

**Amy:** I like that approach. Gives us flexibility to search summaries for quick answers, but still have access to full context when needed.

**Justin:** Alright, so we're thinking: store full transcripts, generate summaries, index summaries, and clean up old data. Sound like a plan?

**Herman:** Yeah, that works. Should we create a ticket for this or just start implementing?

**Amy:** Let's create a ticket. This feels like it needs some planning before we dive in.

**Justin:** Agreed. I'll create the ticket and we can discuss the technical details there.
