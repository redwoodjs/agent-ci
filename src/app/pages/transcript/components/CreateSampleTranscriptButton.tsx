"use client";

import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { saveTranscriptToR2 } from "../actions";

interface CreateSampleTranscriptButtonProps {
  containerId: string;
  onTranscriptCreated?: () => void;
}

export function CreateSampleTranscriptButton({
  containerId,
  onTranscriptCreated,
}: CreateSampleTranscriptButtonProps) {
  const [isCreating, setIsCreating] = useState(false);

  const createSampleTranscript = () => {
    const baseTime = new Date("2025-09-16T12:00:00Z");

    return {
      id: `transcript-1`,
      meetingId: `meeting-1`,
      title: "RedwoodSDK Feature Discussion",
      createdAt: "2025-09-16T12:00:00Z",
      duration: 156,
      participants: [
        "Peter (CEO)",
        "Justin (Software Developer)",
        "Amy (Software Developer)",
      ],
      entries: [
        {
          id: "entry-1",
          timestamp: new Date(baseTime.getTime() + 0 * 1000).toISOString(),
          speaker: "Peter",
          text: "Okay, uh, so here's something I've been thinking about. What if we built a general-purpose storage library that has the exact same API as Cloudflare's R2? Like, literally drop-in compatible. So… anyone on Vercel, or Next, or Remix, or whatever, could just swap in Cloudflare when they want the platform benefits.",
          confidence: 0.95,
        },
        {
          id: "entry-2",
          timestamp: new Date(baseTime.getTime() + 18 * 1000).toISOString(),
          speaker: "Justin",
          text: "A universal R2 client? That's… actually kind of neat. But, wait—R2 is already S3-compatible, right? Wouldn't folks just, like, grab the AWS SDK and call it a day?",
          confidence: 0.92,
        },
        {
          id: "entry-3",
          timestamp: new Date(baseTime.getTime() + 29 * 1000).toISOString(),
          speaker: "Amy",
          text: "Yeah, technically, but—come on—the S3 API is kind of, um… clunky. If you could re-expose it in a way that's cleaner, async/await friendly—like bucket.put(), bucket.get()—I think that's a real DX win.",
          confidence: 0.88,
        },
        {
          id: "entry-4",
          timestamp: new Date(baseTime.getTime() + 44 * 1000).toISOString(),
          speaker: "Peter",
          text: "Exactly, that's what I mean. S3 is portable but not ergonomic. Our pitch would be: you learn one nice API, and it just works everywhere.",
          confidence: 0.94,
        },
        {
          id: "entry-5",
          timestamp: new Date(baseTime.getTime() + 55 * 1000).toISOString(),
          speaker: "Justin",
          text: 'Okay, but let me poke at that. Are we talking Cloudflare-only under the hood, or are we saying "adapters" so people can plug in S3, local disk, whatever?',
          confidence: 0.91,
        },
        {
          id: "entry-6",
          timestamp: new Date(baseTime.getTime() + 66 * 1000).toISOString(),
          speaker: "Amy",
          text: "Mmm, I'd lean adapters. Keep the API thin, just the basics—reads, writes, deletes. Cloudflare gets first-class support, but anyone else can write their own.",
          confidence: 0.93,
        },
        {
          id: "entry-7",
          timestamp: new Date(baseTime.getTime() + 78 * 1000).toISOString(),
          speaker: "Peter",
          text: "Right. And for RedwoodSDK, it would just pick up the Cloudflare binding automatically. But outside Redwood, you import it standalone.",
          confidence: 0.96,
        },
        {
          id: "entry-8",
          timestamp: new Date(baseTime.getTime() + 87 * 1000).toISOString(),
          speaker: "Justin",
          text: "Yeah, okay. But scope creep alarm bells, right? We've always said Redwood should stick to Requests and Responses. Is this us accidentally… building a storage library company?",
          confidence: 0.89,
        },
        {
          id: "entry-9",
          timestamp: new Date(baseTime.getTime() + 99 * 1000).toISOString(),
          speaker: "Amy",
          text: "True, true. But—think about it—if this takes off, it pulls people towards Redwood. Because they're already familiar with the API before they even try the framework.",
          confidence: 0.87,
        },
        {
          id: "entry-10",
          timestamp: new Date(baseTime.getTime() + 110 * 1000).toISOString(),
          speaker: "Peter",
          text: "Yeah, that's the play. Make R2 the default developer storage story without them even noticing. And we can brand it as its own package—something like @redwoodjs/storage—so it doesn't feel like scope creep, even though we get the benefit.",
          confidence: 0.92,
        },
        {
          id: "entry-11",
          timestamp: new Date(baseTime.getTime() + 125 * 1000).toISOString(),
          speaker: "Justin",
          text: "Mm. Keep it minimal. A few async methods, and maybe, like, an in-memory backend for local dev. Nothing more.",
          confidence: 0.94,
        },
        {
          id: "entry-12",
          timestamp: new Date(baseTime.getTime() + 133 * 1000).toISOString(),
          speaker: "Amy",
          text: "And please—not the entire S3 surface area. Just the 80/20 that devs actually touch.",
          confidence: 0.91,
        },
        {
          id: "entry-13",
          timestamp: new Date(baseTime.getTime() + 140 * 1000).toISOString(),
          speaker: "Peter",
          text: "Yup. Okay, so… decision?",
          confidence: 0.98,
        },
        {
          id: "entry-14",
          timestamp: new Date(baseTime.getTime() + 143 * 1000).toISOString(),
          speaker: "Justin",
          text: "I'd say prototype it as a separate package. Redwood consumes it internally, we kick the tires, and if it feels right—we pitch it broader.",
          confidence: 0.93,
        },
        {
          id: "entry-15",
          timestamp: new Date(baseTime.getTime() + 151 * 1000).toISOString(),
          speaker: "Amy",
          text: "Yeah, I'm good with that. Start small, validate, don't over-engineer.",
          confidence: 0.95,
        },
        {
          id: "entry-16",
          timestamp: new Date(baseTime.getTime() + 156 * 1000).toISOString(),
          speaker: "Peter",
          text: "Cool. Done. That's the plan.",
          confidence: 0.97,
        },
      ],
    };
  };

  const handleCreateSample = async () => {
    setIsCreating(true);

    try {
      const sampleTranscript = createSampleTranscript();
      const result = await saveTranscriptToR2(containerId, sampleTranscript);

      if (result.success) {
        // Refresh the page to show the new transcript
        window.location.reload();
      } else {
        console.error("Failed to create sample transcript:", result.error);
        alert("Failed to create sample transcript. Please try again.");
      }
    } catch (error) {
      console.error("Error creating sample transcript:", error);
      alert("Error creating sample transcript. Please try again.");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Button
      onClick={handleCreateSample}
      disabled={isCreating}
      variant="outline"
      size="sm"
    >
      {isCreating ? "Creating..." : "Create Sample Transcript"}
    </Button>
  );
}
