"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

const AGENT_INSTRUCTIONS = `## CI

Before completing any work, you MUST run and pass CI locally:

- Run: \`npx @redwoodjs/agent-ci run --quiet --all --pause-on-failure\`
- When a step fails, the run pauses automatically. Fix the issue and retry: \`npx @redwoodjs/agent-ci retry --name <runner>\`
- CI was green before you started. Any failure is caused by your changes — do not assume pre-existing failures
- Do NOT push to trigger remote CI when agent-ci can run it locally`;

export function CopyAgentInstructions() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(AGENT_INSTRUCTIONS);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-2 px-4 py-2 bg-[#161b18] border border-[#3f6f5e] text-[#9bc5b3] hover:bg-[#243c34] hover:text-[#e0eee5] transition-all rounded-sm font-mono text-sm uppercase tracking-wider"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied!" : "Copy agent instructions"}
    </button>
  );
}
