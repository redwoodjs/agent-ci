09:58 Peter: A user reported a Radix UI hydration issue. I dug in and it looks like server and client IDs don’t match.
10:00 Peter: So we might have a disconnect between how IDs get generated during SSR vs on the client.
10:02 Justin: Yeah, likely because our SSR renders `Document` first, which bumps the server’s useId counter before the app. The client starts at the app root, so the sequences don’t line up.
10:07 Herman: What’s the plan to fix it?
10:08 Justin: Split into two independent renders. One renders the app to an appHtmlStream with a clean useId context. The other renders `Document` with a placeholder. Our stitcher streams `Document`, pauses at the marker, injects appHtmlStream, then continues.
10:14 Peter: Could those two renders end up generating the same IDs?
10:16 Justin: We’ll use distinct identifierPrefix values per render so they can’t collide when stitched.
10:20 Herman: What about streaming and the head preamble?
10:22 Justin: We stream up to `</head>`, fix the preamble extractor, inject the app stream at the placeholder, then resume the rest of `Document`.
10:27 Peter: Any changes for users?
10:28 Justin: Their `Document` becomes a real RSC (async is fine). We remove `Document` from the old transform options and document the new render APIs and identifierPrefix.
10:34 Herman: Tests and CI?
10:35 Justin: We’ll extend e2e to check ID patterns, hydration success, and timing, and adjust imports and option names.
10:41 Peter: Sounds good. Let’s do it.
10:42 Justin: I’ll open the PR.
