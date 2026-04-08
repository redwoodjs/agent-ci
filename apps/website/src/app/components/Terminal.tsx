"use client";

import { useState } from "react";
import { Terminal as TerminalIcon, Copy, Check } from "lucide-react";

function cn(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(" ");
}

interface TerminalProps {
  code: string;
  language?: string;
  className?: string;
  title?: string;
}

export function Terminal({ code, language = "bash", className, title }: TerminalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "min-w-0 rounded-md overflow-clip border border-[#34594c] bg-[#0d110f] shadow-lg",
        className,
      )}
    >
      <div className="flex items-center justify-between px-4 py-2 bg-[#12211c] border-b border-[#2b483e]">
        <div className="flex items-center gap-2 text-[#71a792]">
          <TerminalIcon size={14} />
          <span className="font-mono text-xs">{title || language}</span>
        </div>
        <button
          onClick={handleCopy}
          className="text-[#71a792] hover:text-[#c2ddd0] transition-colors"
          aria-label="Copy code"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div className="p-4 overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
        <pre className="font-mono text-sm text-[#e0eee5] leading-relaxed">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}
