"use client";

import { useRef, useEffect, useState } from "react";
import { CopyTextButton } from "./copy-text-button";

export function LogViewer({ text, label }: { text: string; label: string }) {
  const scrollRef = useRef<HTMLTextAreaElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  useEffect(() => {
    if (!userScrolledUp && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, userScrolledUp]);

  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50; // 50px threshold
    setUserScrolledUp(!isAtBottom);
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 mb-2">
        <CopyTextButton text={text} label={label} />
        {userScrolledUp && (
          <button
            onClick={() => {
              setUserScrolledUp(false);
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
            }}
            className="text-[10px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded border border-blue-100 hover:bg-blue-100 transition-colors"
          >
            Resume Auto-scroll
          </button>
        )}
      </div>
      <textarea
        ref={scrollRef}
        onScroll={handleScroll}
        className="w-full border rounded p-2 text-xs font-mono min-h-[60vh] max-h-[80vh] bg-white text-gray-800"
        readOnly
        value={text}
      />
    </>
  );
}
