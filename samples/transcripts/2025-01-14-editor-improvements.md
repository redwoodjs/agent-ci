# Transcript: Editor Improvements Discussion

**Date:** 2025-01-14  
**Participants:** Herman, Amy, Justin  
**Topic:** Editor fixes and improvements

---

**Herman:** So I just merged the editor fixes PR. Removed the preview and terminal view from the editor.

**Amy:** Why did we remove those? I thought they were useful features.

**Herman:** They were causing issues with the new task-based URL structure. The routing was getting messy.

**Justin:** What kind of issues? Were they breaking the navigation?

**Herman:** Yeah, exactly. The preview routes weren't playing nice with the wildcard matching we set up for tasks.

**Amy:** Couldn't we have fixed the routing instead of removing the features?

**Herman:** We could have, but honestly, the editor was getting cluttered. Sometimes less is more.

**Justin:** I get that. But users might miss having the preview right there in the editor.

**Herman:** True. Maybe we can add it back later with better routing. For now, let's focus on making the core editing experience solid.

**Amy:** What about the terminal? That seems pretty essential for a development environment.

**Herman:** Yeah, that one I'm less sure about removing. But it was causing the same routing issues.

**Justin:** Maybe we could add a separate terminal tab or panel? Keep it accessible but not cluttering the main editor.

**Amy:** That could work. Or maybe a floating terminal that can be toggled on/off?

**Herman:** Both good ideas. Let's add that to the backlog. For now, the editor should be more stable without those components.

**Justin:** Fair enough. Did you test the new URL structure thoroughly?

**Herman:** Yeah, I went through all the main flows. The task-based routing is working much better now.

**Amy:** Good. I'll test it on my end too and let you know if I find any issues.

**Justin:** Same here. Thanks for cleaning that up, Herman.
