# Issue #1: Implement transcript indexing for RAG system

**Labels:** enhancement, performance, ai  
**Priority:** Medium  
**Assignee:** @amy  
**Created:** 2025-01-15

## Description

The RAG experiment is storing transcripts in the database, but we need to implement proper indexing to make them searchable without performance issues.

## Current State

- Transcripts are being stored in the database
- No indexing or search functionality implemented
- Performance concerns with large transcript volumes

## Requirements

- [ ] Implement search indexing for transcripts
- [ ] Add keyword search functionality
- [ ] Set up cleanup job for old transcripts
- [ ] Consider storing summaries alongside full transcripts
- [ ] Add performance monitoring for search queries

## Acceptance Criteria

- Users can search through their conversation history
- Search performance remains acceptable with large datasets
- Old transcripts are automatically cleaned up
- System can handle concurrent search requests

---

## Comments

**@herman** - 2025-01-15 10:30 AM  
👍 We should probably start with a simple keyword search and see how it performs. We can always add more sophisticated indexing later.

**@justin** - 2025-01-15 11:15 AM  
Good point. We should also set up some limits - maybe only index the last N conversations per user, or conversations from the last 30 days.

**@amy** - 2025-01-15 2:45 PM  
I like the approach of storing both summaries and full transcripts. Gives us flexibility to search summaries for quick answers, but still have access to full context when needed.

**@herman** - 2025-01-15 3:20 PM  
We could use the AI to summarize conversations and store both the summary and the full transcript. That way we get the best of both worlds.

**@justin** - 2025-01-15 4:10 PM  
Sounds like a plan. Should we create a separate ticket for the AI summarization feature, or include it in this one?

**@amy** - 2025-01-15 4:30 PM  
Let's include it in this one since they're closely related. I'll start working on the basic indexing first, then add the summarization feature.
