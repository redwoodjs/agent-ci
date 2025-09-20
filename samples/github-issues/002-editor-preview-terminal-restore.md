# Issue #2: Restore preview and terminal views to editor

**Labels:** enhancement, ui, editor  
**Priority:** High  
**Assignee:** @herman  
**Created:** 2025-01-14

## Description

The preview and terminal views were removed from the editor to fix routing issues, but users are missing these essential features for a development environment.

## Current State

- Preview and terminal views removed from editor
- Routing issues resolved with task-based URL structure
- Users need to access these features elsewhere

## Requirements

- [ ] Add preview view back to editor with proper routing
- [ ] Add terminal view back to editor with proper routing
- [ ] Ensure new implementation works with task-based URLs
- [ ] Consider floating/panel options for better UX
- [ ] Add toggle controls for showing/hiding views

## Acceptance Criteria

- Users can access preview directly from editor
- Users can access terminal directly from editor
- No routing conflicts with task-based URL structure
- Views can be toggled on/off as needed
- Performance remains acceptable

---

## Comments

**@amy** - 2025-01-14 9:15 AM  
Wait, why did we remove these features? I thought they were pretty useful for the dev workflow 🤔

**@herman** - 2025-01-14 9:45 AM  
They were causing issues with the new task-based URL structure. The routing was getting messy and breaking navigation.

**@justin** - 2025-01-14 10:20 AM  
Couldn't we have fixed the routing instead of removing the features? Users might miss having the preview right there in the editor.

**@herman** - 2025-01-14 11:00 AM  
We could have, but honestly, the editor was getting cluttered. Sometimes less is more. But you're right, we should add them back with better implementation.

**@amy** - 2025-01-14 2:30 PM  
What about the terminal? That seems pretty essential for a development environment.

**@justin** - 2025-01-14 3:15 PM  
Maybe we could add a separate terminal tab or panel? Keep it accessible but not cluttering the main editor.

**@herman** - 2025-01-14 4:00 PM  
Both good ideas. Let's add that to the backlog. For now, the editor should be more stable without those components, but we definitely need to bring them back.

**@amy** - 2025-01-14 4:45 PM  
I'll start working on the preview view first, then move on to the terminal. Should be easier to implement with the new routing structure.
