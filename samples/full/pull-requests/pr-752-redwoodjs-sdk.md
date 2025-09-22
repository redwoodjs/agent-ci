# Pull Request #752 — fix: useId() mismatch between SSR and client side
**Repository:** redwoodjs/sdk  
**URL:** https://github.com/redwoodjs/sdk/pull/752  
**State:** Merged  
**Merged:** Sep 21, 2025  
**From:** radix-ui → **Into:** main  
**Author:** @justinvdm

---

## Description

### Context: The Previous Rendering Architecture

Previously, the framework used a single, nested rendering pass on the server to produce the initial HTML document. The user's `<Document>` component (containing the `<html>`, `<head>`, etc.) was rendered using React's standard Server-Side Rendering (SSR). As part of this same render, the framework would resolve the React Server Component (RSC) payload for the page and render its contents into the document shell.

### Problem: Non-Deterministic `useId` Generation

This approach created a hydration mismatch for client components relying on `React.useId` (such as those in Radix UI). React's hydration for `useId` requires deterministic rendering—the sequence of hook calls that generate IDs must be identical on the server and the client.
Our single-pass architecture broke this determinism. The server would first traverse and render the components within the `<Document>` shell, advancing React's internal `useId` counter. Only then would it proceed to render the actual application components. The client, however, only hydrates the application content within the document, starting with a fresh `useId` counter.
This discrepancy meant the server was performing extra rendering work that the client was unaware of, leading to a mismatch in the final IDs (e.g., server `_R_76_` vs. client `_r_0_`). This caused React to discard the server-rendered DOM, breaking interactivity and negating the benefits of SSR.

### Solution: Isolate, Render, and Stitch

The solution was to re-architect the server-side rendering pipeline to enforce context isolation. The new "Nested Renders with Stream Stitching" model works as follows:
  1. Isolated Renders: Instead of one nested render, we now perform two completely separate and concurrent renders on the server:
     * One for the application content, which generates an HTML stream (`appHtmlStream`). This guarantees it renders in a clean context with a fresh `useId` counter.
     * One for the `<Document>` shell, which generates another HTML stream (`documentHtmlStream`) containing a placeholder comment.
  2. Stream Stitching: A custom utility merges these two streams on the fly. It streams the document shell until it finds the placeholder, at which point it injects the application's complete HTML stream before continuing with the rest of the document.
This approach guarantees that the application content is rendered in an isolated context, ensuring the `useId` sequence generated on the server is identical to the one generated on the client during hydration, while at the same time ensuring streaming isn't blocked for both the document and app RSC renders.
An important secondary benefit of this change is that the user-defined `<Document>` is now a true React Server Component. This aligns with developer expectations and unlocks the full power of the RSC paradigm (e.g., using `async/await` for data fetching, accessing server-only APIs) directly within the document shell, which was not possible before. The full details of this new architecture are captured in the updated Hybrid Rendering documentation.

---

## Comments

**@Tobbe — Sep 20, 2025**

> Isolated Renders: Instead of one nested render, we now perform two completely separate and concurrent renders on the server:
>  One for the application content, which generates an HTML stream (appHtmlStream). This guarantees it renders in a clean context with a fresh useId counter.
>  One for the shell, which generates another HTML stream (documentHtmlStream) containing a placeholder comment.
> Does this mean there's a chance of IDs colliding? Could `useId()` in one context potentially generate the same id as the `useId()` in the other context?

**@justinvdm — Sep 20, 2025**

> > Isolated Renders: Instead of one nested render, we now perform two completely separate and concurrent renders on the server:
> >  One for the application content, which generates an HTML stream (appHtmlStream). This guarantees it renders in a clean context with a fresh useId counter.
> >  One for the shell, which generates another HTML stream (documentHtmlStream) containing a placeholder comment.
> >
> > Does this mean there's a chance of IDs colliding? Could `useId()` in one context potentially generate the same id as the `useId()` in the other context?
> Do you mean collisions between RSC and SSR/Client ids? If so, good question. React generates ids with different prefixes for the two cases, so we're safe there.

**cloudflare-workers-and-pages (bot) — Sep 20, 2025**

Deploying redwood-sdk-docs with  Cloudflare Pages

Latest commit: `f15063f`  
Status: ✅  Deploy successful!  
Preview URL: https://32ca27b6.redwood-sdk-docs.pages.dev  
Branch Preview URL: https://radix-ui.redwood-sdk-docs.pages.dev

**@Tobbe — Sep 20, 2025**

> > Do you mean collisions between RSC and SSR/Client ids? If so, good question. React generates ids with different prefixes for the two cases, so we're safe there.
>
> I mean, if you have two concurrent renders happening on the server, could a `useId()` call in one of those renders generate the same id as a `useId()` call in the other, such that when you stitch them together later you now have two IDs that are the same.

**@justinvdm — Sep 20, 2025**

> > > Do you mean collisions between RSC and SSR/Client ids? If so, good question. React generates ids with different prefixes for the two cases, so we're safe there.
> >
> > I mean, if you have two concurrent renders happening on the server, could a `useId()` call in one of those renders generate the same id as a `useId()` call in the other, such that when you stitch them together later you now have two IDs that are the same.
> Ah yes, good catch, I'll add different id prefixes to solve that, thanks!

---

*Extracted verbatim (title, description, and comments) from PR #752 as of 2025-09-22 (Africa/Johannesburg).*

