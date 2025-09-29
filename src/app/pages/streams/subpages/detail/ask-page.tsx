"use client";

import { useState } from "react";
import { Send, Paperclip } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
// import { StreamHeader } from "./components/stream-header";
// import { LeftRail } from "./components/left-rail";
import { ConversationView } from "./views/conversation-view";
import { mockStreams } from "../../mock-data";

interface AskPageProps {
  params: {
    streamID: string;
  };
}

export function AskPage({ params }: AskPageProps) {
  const [inputValue, setInputValue] = useState("");
  const stream = mockStreams.find((s) => s.id === params.streamID);

  const handleBack = () => {
    window.location.href = "/streams";
  };

  const handleSend = () => {
    if (inputValue.trim()) {
      setInputValue("");
    }
  };

  if (!stream) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Stream not found</h1>
          <p className="text-muted-foreground">
            The stream you're looking for doesn't exist.
          </p>
          <a
            href="/streams"
            className="text-blue-600 hover:underline mt-4 inline-block"
          >
            Back to streams
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      {/* <StreamHeader stream={stream} onBack={handleBack} /> */}

      <div className="flex h-[calc(100vh-80px)]">
        {/* <LeftRail
          activeSection="ask"
          onSectionChange={() => {}} // Navigation handled by URL changes
          stream={stream}
        /> */}

        <div className="flex-1 flex flex-col">
          <div className="p-6 border-b bg-white border-gray-200">
            <div className="max-w-4xl">
              <div className="relative">
                <Input
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="How can I help you?"
                  className="pr-20 py-3"
                  onKeyDown={(e) => e.key === "Enter" && handleSend()}
                />
                <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex items-center gap-2">
                  <Button variant="ghost" size="sm">
                    <Paperclip className="w-4 h-4" />
                    Attach
                  </Button>
                  <Button variant="ghost" size="sm" className="text-xs">
                    GPT-4.1
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <ConversationView stream={stream} />
        </div>
      </div>
    </div>
  );
}
