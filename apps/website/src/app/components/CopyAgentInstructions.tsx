"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

const AGENT_INSTRUCTIONS = `## agent-ci

Install: \`npm install -D @redwoodjs/agent-ci\`

- Use \`npx @redwoodjs/agent-ci run --quiet --all\` to run CI locally
- When a step fails, the run pauses automatically. Use \`npx @redwoodjs/agent-ci retry --name <runner>\` to retry after fixing the failure
- Do NOT push to trigger remote CI when agent-ci can run it locally — it's instant and free
- CI was green before you started. Any failure is caused by your changes — do not assume pre-existing failures
- Use \`--no-matrix\` to collapse matrix jobs into a single run when you don't need full matrix coverage`;

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
