"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Play, Copy, Check } from "lucide-react";
import { Panel } from "./Panel";

export function HeroSection() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText("npx @redwoodjs/agent-ci run --all");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="grid lg:grid-cols-2 gap-16 items-center mb-32 mt-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <h2 className="text-5xl lg:text-7xl font-bold tracking-tight mb-6 text-[#f2f7f4] leading-[1.1] font-serif">
          Run GitHub Actions on your machine.
        </h2>
        <p className="text-xl text-[#9bc5b3] mb-8 leading-relaxed font-sans max-w-xl">
          Caching in ~0 ms. Pause on failure. Let your AI agent fix it and retry — without pushing.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 mb-8">
          <a
            href="#quick-start"
            className="flex items-center justify-center gap-2 px-6 py-3 bg-[#528b76] text-[#0d110f] hover:bg-[#71a792] font-mono font-bold uppercase tracking-wider rounded-sm transition-colors shadow-[0_0_15px_rgba(82,139,118,0.4)]"
          >
            <Play size={18} />
            Initialize
          </a>

          <div className="flex items-center justify-between px-4 py-3 bg-[#12211c] border border-[#34594c] rounded-sm font-mono text-sm text-[#c2ddd0] flex-1">
            <span>npx @redwoodjs/agent-ci run --all</span>
            <button
              onClick={handleCopy}
              className="text-[#71a792] hover:text-[#e0eee5] transition-colors ml-4"
              aria-label="Copy command"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, delay: 0.2 }}
        className="relative"
      >
        <Panel title="agent-ci-terminal" glow className="flex flex-col">
          <div className="font-mono text-sm text-[#9bc5b3] space-y-2 flex-1 overflow-y-auto">
            <p>
              <span className="text-[#528b76]">❯</span> npx agent-ci run --workflow
              .github/workflows/ci.yml
            </p>
            <p className="text-[#71a792]">Initializing local runner environment...</p>
            <p className="text-[#71a792]">Mounting local workspace: /Users/dev/project</p>
            <p className="text-[#71a792]">Starting job: test-and-build</p>
            <br />
            <p>✓ Run actions/checkout@v4 (0s)</p>
            <p>✓ Run actions/setup-node@v4 (0s)</p>
            <p>✓ Run npm install (0s - cached)</p>
            <p className="text-[#e0eee5]">▶ Run npm run test</p>
            <p className="text-red-400"> ✖ 1 failing test</p>
            <p className="text-red-400"> Error: Expected true to be false</p>
            <br />
            <p className="text-yellow-400 font-bold">⚠️ Step failed. Runner paused.</p>
            <p className="text-[#71a792]">Container state preserved. Fix the issue and run:</p>
            <p className="text-[#e0eee5] bg-[#243c34] inline-block px-2 py-1 mt-1">
              npx agent-ci retry --name runner-test-and-build
            </p>
            <motion.div
              animate={{ opacity: [1, 0] }}
              transition={{ repeat: Infinity, duration: 0.8 }}
              className="w-2 h-4 bg-[#528b76] inline-block ml-2 align-middle"
            />
          </div>
        </Panel>

        {/* Decorative elements */}
        <div className="absolute -right-4 top-10 w-8 h-[200px] border-r border-y border-[#2b483e] opacity-50"></div>
        <div className="absolute -left-4 bottom-10 w-8 h-[100px] border-l border-y border-[#2b483e] opacity-50"></div>
      </motion.div>
    </div>
  );
}
