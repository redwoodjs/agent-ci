# Transcript: Drag and Drop Implementation

**Date:** 2025-01-13  
**Participants:** Herman, Amy, Justin  
**Topic:** Adding drag-and-drop functionality for task cards and lanes

---

**Herman:** Just pushed the drag-and-drop functionality for task cards and lanes. Took longer than expected.

**Amy:** What was the tricky part? The drag events themselves or the state management?

**Herman:** Both, honestly. Getting the drag events to work smoothly across different browsers was a pain.

**Justin:** Did you use a library or implement it from scratch?

**Herman:** Started with a library but ended up implementing most of it from scratch. The library was adding too much overhead.

**Amy:** What library did you try first?

**Herman:** react-beautiful-dnd. It's great for simple cases, but we needed more control over the behavior.

**Justin:** What specific behavior were you trying to achieve?

**Herman:** We needed to support dragging between different lanes, and the library was making assumptions about the layout that didn't fit our use case.

**Amy:** Makes sense. Sometimes the custom implementation is worth the extra work.

**Justin:** How's the performance? Drag and drop can get laggy with lots of items.

**Herman:** It's pretty smooth so far. I'm using requestAnimationFrame for the updates and only re-rendering what's necessary.

**Amy:** Did you add any visual feedback during dragging?

**Herman:** Yeah, there's a drop zone indicator and the dragged item gets a slight opacity change.

**Justin:** Nice. What about touch support for mobile?

**Herman:** That's next on the list. The current implementation is mouse-only.

**Amy:** Should we prioritize mobile support? How important is that for our users?

**Justin:** Probably not critical for a development environment, but good to have eventually.

**Herman:** Agreed. Let's get the desktop experience solid first, then add mobile support.

**Amy:** Sounds good. I'll test the drag and drop on my end and see if I can break it.

**Justin:** Same here. Good work on getting this working, Herman.
