"use client";

import { Input } from "@/app/components/ui/input";
import { Button } from "@/app/components/ui/button";
// import { Paperclip } from "lucide-react";
import { Send, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { ask } from "./actions";

export function AskPage({ params }: { params: { streamID: string } }) {
  const [inputValue, setInputValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const [response, setResponse] = useState("");

  const handleSend = () => {
    startTransition(async () => {
      const r = await ask({
        streamID: parseInt(params.streamID),
        prompt: inputValue,
      });
      setResponse(r);
    });
  };

  return (
    <div className="flex-1 flex flex-col">
      <div className="p-6 border-b bg-white border-gray-200">
        <div className="max-w-4xl">
          <div className="relative">
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="What would you like to know?"
              className="pr-20 py-3"
              disabled={isPending}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
            />
            <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleSend}
                disabled={isPending || !inputValue.trim()}
              >
                {isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
        <div className="mt-4">
          <div className="whitespace-pre-wrap text-sm">{response}</div>
        </div>
      </div>
    </div>
  );
}
