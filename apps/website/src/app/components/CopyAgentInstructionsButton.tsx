"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

const AGENT_INSTRUCTIONS = `Please set up Agent CI in this project:

1. Install the package:
   npm install -D @redwoodjs/agent-ci

2. Create or update AGENTS.md (or CLAUDE.md) with the following:

## CI (via agent-ci)

- Run CI locally: \`npx agent-ci run --quiet --workflow .github/workflows/ci.yml\`
- On step failure, the runner pauses automatically. Fix the issue then retry: \`npx agent-ci retry --name <runner-name>\`
- Do NOT push to trigger remote CI — use agent-ci instead (instant, free, no waiting)
- Assume CI was green before your changes; any failure is caused by your changes
- Use \`--no-matrix\` to collapse matrix jobs for faster iteration`;

export function CopyAgentInstructionsButton() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(AGENT_INSTRUCTIONS);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center justify-center gap-2 px-6 py-3 bg-[#161b18] border border-[#3f6f5e] text-[#9bc5b3] hover:bg-[#243c34] hover:text-[#e0eee5] font-mono font-bold uppercase tracking-wider rounded-sm transition-colors"
    >
      {copied ? <Check size={18} /> : <Copy size={18} />}
      {copied ? "Copied!" : "Copy for agent"}
    </button>
  );
}
