import { Panel } from "../components/Panel";
import { Terminal } from "../components/Terminal";
import { HeroSection } from "../components/HeroSection";
import { CopyAgentInstructions } from "../components/CopyAgentInstructions";
import { Terminal as TerminalIcon, Star as StarIcon, Quote as QuoteIcon } from "lucide-react";

export const Home = () => {
  return (
    <div className="min-h-screen relative overflow-hidden selection:bg-[#528b76] selection:text-[#f2f7f4]">
      {/* CRT Effects */}
      <div className="crt-flicker pointer-events-none" />
      <div className="scanline pointer-events-none" />

      {/* Background Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(43,72,62,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(43,72,62,0.1)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,#000_20%,transparent_100%)] pointer-events-none" />

      {/* Sticky Navbar */}
      <nav className="sticky top-0 z-50 border-b border-[#2b483e] bg-[#0d110f]/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-16 flex justify-between items-center">
          <span className="text-xl font-bold tracking-tight text-[#e0eee5] font-sans">
            AGENT-CI
          </span>

          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-[#9bc5b3]">
            <a href="#quick-start" className="hover:text-[#e0eee5] transition-colors">
              Docs
            </a>
            <a href="#principles" className="hover:text-[#e0eee5] transition-colors">
              Principles
            </a>
            <a href="/compatibility" className="hover:text-[#e0eee5] transition-colors">
              Compatibility
            </a>
            <a href="/blog" className="hover:text-[#e0eee5] transition-colors">
              Blog
            </a>
            <a
              href="https://github.com/redwoodjs/agent-ci"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#e0eee5] transition-colors"
            >
              GitHub
            </a>
          </div>

          <a
            href="https://github.com/redwoodjs/agent-ci"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 bg-[#161b18] border border-[#3f6f5e] text-[#9bc5b3] hover:bg-[#243c34] hover:text-[#e0eee5] transition-all rounded-sm font-mono text-sm uppercase tracking-wider"
          >
            <StarIcon size={16} />
            <span className="hidden sm:inline">Star us</span>
          </a>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-12 relative z-10">
        <main>
          <HeroSection />

          {/* Principles Section */}
          <div id="principles" className="mb-32">
            <div className="flex items-center gap-4 mb-12">
              <h2 className="text-3xl font-bold text-[#e0eee5] font-serif">Principles</h2>
              <div className="h-px bg-[#2b483e] flex-1"></div>
            </div>

            <div className="grid md:grid-cols-3 gap-8">
              <div className="space-y-6">
                <div className="pb-4 border-b border-[#34594c]">
                  <h3 className="text-[#71a792] font-mono text-xs uppercase tracking-widest mb-2">
                    Principle
                  </h3>
                  <p className="text-xl font-serif text-[#e0eee5]">Instant Feedback</p>
                </div>
                <div className="pb-4 border-b border-[#34594c]">
                  <h3 className="text-[#71a792] font-mono text-xs uppercase tracking-widest mb-2">
                    Reality
                  </h3>
                  <p className="text-[#9bc5b3] text-sm leading-relaxed">
                    Cloud CI takes minutes to spin up, install dependencies, and run tests. The
                    feedback loop is broken.
                  </p>
                </div>
                <div>
                  <h3 className="text-[#528b76] font-mono text-xs uppercase tracking-widest mb-2">
                    Advantage
                  </h3>
                  <p className="text-[#c2ddd0] text-sm leading-relaxed">
                    By bind-mounting your local{" "}
                    <code className="text-[#71a792] bg-[#12211c] px-1 rounded">node_modules</code>{" "}
                    and tool caches, Agent CI starts in ~0ms. Your first run warms the cache;
                    subsequent runs are instant.
                  </p>
                </div>
              </div>

              <div className="space-y-6">
                <div className="pb-4 border-b border-[#34594c]">
                  <h3 className="text-[#71a792] font-mono text-xs uppercase tracking-widest mb-2">
                    Principle
                  </h3>
                  <p className="text-xl font-serif text-[#e0eee5]">Debug in Place</p>
                </div>
                <div className="pb-4 border-b border-[#34594c]">
                  <h3 className="text-[#71a792] font-mono text-xs uppercase tracking-widest mb-2">
                    Reality
                  </h3>
                  <p className="text-[#9bc5b3] text-sm leading-relaxed">
                    When a cloud CI job fails, the container is destroyed. You have to guess the
                    fix, push, and wait again.
                  </p>
                </div>
                <div>
                  <h3 className="text-[#528b76] font-mono text-xs uppercase tracking-widest mb-2">
                    Advantage
                  </h3>
                  <p className="text-[#c2ddd0] text-sm leading-relaxed">
                    Agent CI pauses on failure. The container stays alive with all state intact. Fix
                    the issue on your host, then retry just the failed step.
                  </p>
                </div>
              </div>

              <div className="space-y-6">
                <div className="pb-4 border-b border-[#34594c]">
                  <h3 className="text-[#71a792] font-mono text-xs uppercase tracking-widest mb-2">
                    Principle
                  </h3>
                  <p className="text-xl font-serif text-[#e0eee5]">True Compatibility</p>
                </div>
                <div className="pb-4 border-b border-[#34594c]">
                  <h3 className="text-[#71a792] font-mono text-xs uppercase tracking-widest mb-2">
                    Reality
                  </h3>
                  <p className="text-[#9bc5b3] text-sm leading-relaxed">
                    Other local runners use custom re-implementations of the GitHub Actions spec,
                    leading to subtle bugs and drift.
                  </p>
                </div>
                <div>
                  <h3 className="text-[#528b76] font-mono text-xs uppercase tracking-widest mb-2">
                    Advantage
                  </h3>
                  <p className="text-[#c2ddd0] text-sm leading-relaxed">
                    Agent CI emulates the server-side API surface and feeds jobs to the unmodified,
                    official GitHub Actions runner binary.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Architecture Comparison Table */}
          <div className="mb-32">
            <div className="flex items-center gap-4 mb-8">
              <h2 className="text-3xl font-bold text-[#e0eee5] font-serif">
                Architecture Comparison
              </h2>
              <div className="h-px bg-[#2b483e] flex-1"></div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#34594c] bg-[#12211c]">
                    <th className="py-4 px-6 font-mono text-xs text-[#71a792] uppercase tracking-wider">
                      Feature
                    </th>
                    <th className="py-4 px-6 font-mono text-xs text-[#71a792] uppercase tracking-wider">
                      GitHub Actions
                    </th>
                    <th className="py-4 px-6 font-mono text-xs text-[#71a792] uppercase tracking-wider">
                      Other local runners
                    </th>
                    <th className="py-4 px-6 font-mono text-xs text-[#528b76] font-bold uppercase tracking-wider bg-[#161b18]">
                      Agent CI
                    </th>
                  </tr>
                </thead>
                <tbody className="text-sm text-[#c2ddd0]">
                  <tr className="border-b border-[#243c34] hover:bg-[#12211c] transition-colors">
                    <td className="py-4 px-6 font-medium">Runner binary</td>
                    <td className="py-4 px-6 text-[#9bc5b3]">Official</td>
                    <td className="py-4 px-6 text-[#9bc5b3]">Custom re-implementation</td>
                    <td className="py-4 px-6 font-bold text-[#e0eee5] bg-[#161b18]">Official</td>
                  </tr>
                  <tr className="border-b border-[#243c34] hover:bg-[#12211c] transition-colors">
                    <td className="py-4 px-6 font-medium">API layer</td>
                    <td className="py-4 px-6 text-[#9bc5b3]">GitHub.com</td>
                    <td className="py-4 px-6 text-[#9bc5b3]">Compatibility shim</td>
                    <td className="py-4 px-6 font-bold text-[#e0eee5] bg-[#161b18]">
                      Full local emulation
                    </td>
                  </tr>
                  <tr className="border-b border-[#243c34] hover:bg-[#12211c] transition-colors">
                    <td className="py-4 px-6 font-medium">Cache round-trip</td>
                    <td className="py-4 px-6 text-[#9bc5b3]">Network (~seconds)</td>
                    <td className="py-4 px-6 text-[#9bc5b3]">Varies</td>
                    <td className="py-4 px-6 font-bold text-[#e0eee5] bg-[#161b18]">
                      ~0 ms (bind-mount)
                    </td>
                  </tr>
                  <tr className="border-b border-[#243c34] hover:bg-[#12211c] transition-colors">
                    <td className="py-4 px-6 font-medium">On failure</td>
                    <td className="py-4 px-6 text-[#9bc5b3]">Start over</td>
                    <td className="py-4 px-6 text-[#9bc5b3]">Start over</td>
                    <td className="py-4 px-6 font-bold text-[#e0eee5] bg-[#161b18]">
                      Pause → fix → retry step
                    </td>
                  </tr>
                  <tr className="border-b border-[#243c34] hover:bg-[#12211c] transition-colors">
                    <td className="py-4 px-6 font-medium">Container state</td>
                    <td className="py-4 px-6 text-[#9bc5b3]">Destroyed</td>
                    <td className="py-4 px-6 text-[#9bc5b3]">Destroyed</td>
                    <td className="py-4 px-6 font-bold text-[#e0eee5] bg-[#161b18]">Kept alive</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Testimonials */}
          <div className="mb-32">
            <div className="flex items-center gap-4 mb-12">
              <h2 className="text-3xl font-bold text-[#e0eee5] font-serif">
                In Developers' Own Words
              </h2>
              <div className="h-px bg-[#2b483e] flex-1"></div>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <Panel title="x.com/jessmartin" className="bg-[#12211c]">
                <QuoteIcon className="text-[#34594c] mb-4" size={32} />
                <p className="text-[#e0eee5] text-xl leading-relaxed mb-6 font-serif">
                  "Waiting for CI could be the subtitle of the book of the last 3 weeks of my life
                  <br />
                  The Factory Life: Waiting for CI"
                </p>
                <div className="flex items-center gap-3">
                  <img
                    src="https://pbs.twimg.com/profile_images/2030389216979349504/VLJlOJsF_normal.jpg"
                    alt="Jess Martin"
                    className="w-10 h-10 rounded-full border border-[#3f6f5e]"
                    referrerPolicy="no-referrer"
                  />
                  <div>
                    <p className="text-[#e0eee5] font-bold text-sm">Jess Martin</p>
                    <p className="text-[#71a792] text-xs font-mono">@jessmartin</p>
                  </div>
                </div>
              </Panel>

              <Panel title="x.com/ericclemmons" className="bg-[#12211c]">
                <QuoteIcon className="text-[#34594c] mb-4" size={32} />
                <p className="text-[#e0eee5] text-xl leading-relaxed mb-6 font-serif">
                  "An alternative to Act for AI? I'll take it!"
                </p>
                <div className="flex items-center gap-3">
                  <img
                    src="https://pbs.twimg.com/profile_images/2015635972948369408/hNCOwizq_normal.jpg"
                    alt="Eric Clemmons"
                    className="w-10 h-10 rounded-full border border-[#3f6f5e]"
                    referrerPolicy="no-referrer"
                  />
                  <div>
                    <p className="text-[#e0eee5] font-bold text-sm">Eric Clemmons 🍊☁️</p>
                    <p className="text-[#71a792] text-xs font-mono">@ericclemmons</p>
                  </div>
                </div>
              </Panel>

              <Panel title="x.com/cyrusnewday" className="bg-[#12211c]">
                <QuoteIcon className="text-[#34594c] mb-4" size={32} />
                <p className="text-[#e0eee5] text-xl leading-relaxed mb-6 font-serif">
                  "Clever dude!"
                </p>
                <div className="flex items-center gap-3">
                  <img
                    src="https://unavatar.io/x/cyrusnewday"
                    alt="Cyrus"
                    className="w-10 h-10 rounded-full border border-[#3f6f5e]"
                    referrerPolicy="no-referrer"
                  />
                  <div>
                    <p className="text-[#e0eee5] font-bold text-sm">Cyrus</p>
                    <p className="text-[#71a792] text-xs font-mono">@cyrusnewday</p>
                  </div>
                </div>
              </Panel>

              <Panel title="x.com/chriszeuch" className="bg-[#12211c]">
                <QuoteIcon className="text-[#34594c] mb-4" size={32} />
                <p className="text-[#e0eee5] text-xl leading-relaxed mb-6 font-serif">
                  "Okay this is awesome"
                </p>
                <div className="flex items-center gap-3">
                  <img
                    src="https://unavatar.io/x/chriszeuch"
                    alt="Chris"
                    className="w-10 h-10 rounded-full border border-[#3f6f5e]"
                    referrerPolicy="no-referrer"
                  />
                  <div>
                    <p className="text-[#e0eee5] font-bold text-sm">Chris 🧑‍🌾</p>
                    <p className="text-[#71a792] text-xs font-mono">@chriszeuch</p>
                  </div>
                </div>
              </Panel>

              <Panel title="x.com/EastlondonDev" className="bg-[#12211c]">
                <QuoteIcon className="text-[#34594c] mb-4" size={32} />
                <p className="text-[#e0eee5] text-xl leading-relaxed mb-6 font-serif">
                  "I like the look of what you're cooking here 👀"
                </p>
                <div className="flex items-center gap-3">
                  <img
                    src="https://unavatar.io/x/EastlondonDev"
                    alt="Andrew Jefferson"
                    className="w-10 h-10 rounded-full border border-[#3f6f5e]"
                    referrerPolicy="no-referrer"
                  />
                  <div>
                    <p className="text-[#e0eee5] font-bold text-sm">Andrew Jefferson</p>
                    <p className="text-[#71a792] text-xs font-mono">@EastlondonDev</p>
                  </div>
                </div>
              </Panel>

              <Panel title="x.com/bebraw" className="bg-[#12211c]">
                <QuoteIcon className="text-[#34594c] mb-4" size={32} />
                <p className="text-[#e0eee5] text-xl leading-relaxed mb-6 font-serif">
                  "Nice! Exactly what I needed."
                </p>
                <div className="flex items-center gap-3">
                  <img
                    src="https://unavatar.io/x/bebraw"
                    alt="Juho Vepsäläinen"
                    className="w-10 h-10 rounded-full border border-[#3f6f5e]"
                    referrerPolicy="no-referrer"
                  />
                  <div>
                    <p className="text-[#e0eee5] font-bold text-sm">Juho Vepsäläinen</p>
                    <p className="text-[#71a792] text-xs font-mono">@bebraw</p>
                  </div>
                </div>
              </Panel>

              <Panel title="x.com/MrAhmadAwais" className="bg-[#12211c]">
                <QuoteIcon className="text-[#34594c] mb-4" size={32} />
                <p className="text-[#e0eee5] text-xl leading-relaxed mb-6 font-serif">
                  "Oh noice."
                </p>
                <div className="flex items-center gap-3">
                  <img
                    src="https://unavatar.io/x/MrAhmadAwais"
                    alt="Ahmad Awais"
                    className="w-10 h-10 rounded-full border border-[#3f6f5e]"
                    referrerPolicy="no-referrer"
                  />
                  <div>
                    <p className="text-[#e0eee5] font-bold text-sm">Ahmad Awais</p>
                    <p className="text-[#71a792] text-xs font-mono">@MrAhmadAwais</p>
                  </div>
                </div>
              </Panel>
            </div>
          </div>

          {/* Quick Start & AI Agent Integration */}
          <div id="quick-start" className="grid lg:grid-cols-2 gap-12 mb-24">
            <div>
              <div className="flex items-center gap-4 mb-8">
                <h2 className="text-3xl font-bold text-[#e0eee5] font-serif">Quick Start</h2>
                <CopyAgentInstructions />
                <div className="h-px bg-[#2b483e] flex-1"></div>
              </div>

              <div className="space-y-6">
                <div>
                  <h4 className="font-mono text-sm text-[#71a792] uppercase tracking-wider mb-2">
                    1. Install
                  </h4>
                  <Terminal
                    code="npm install -D @redwoodjs/agent-ci"
                    language="bash"
                    title="Terminal"
                  />
                </div>

                <div>
                  <h4 className="font-mono text-sm text-[#71a792] uppercase tracking-wider mb-2">
                    2. Run
                  </h4>
                  <Terminal
                    code={`# Run a specific workflow\nnpx agent-ci run --workflow .github/workflows/ci.yml\n\n# Run all relevant workflows for current branch\nnpx agent-ci run --all`}
                    language="bash"
                    title="Terminal"
                  />
                </div>

                <div>
                  <h4 className="font-mono text-sm text-[#71a792] uppercase tracking-wider mb-2">
                    3. Retry
                  </h4>
                  <Terminal
                    code="npx agent-ci retry --name <runner-name>"
                    language="bash"
                    title="Terminal"
                  />
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-center gap-4 mb-8">
                <h2 className="text-3xl font-bold text-[#e0eee5] font-serif">
                  AI Agent Integration
                </h2>
                <div className="h-px bg-[#2b483e] flex-1"></div>
              </div>

              <p className="text-[#9bc5b3] mb-6 leading-relaxed">
                Agent CI is designed for AI-agent-driven development loops. Add this snippet to your
                project's{" "}
                <code className="bg-[#161b18] border border-[#2b483e] px-1.5 py-0.5 rounded text-[#c2ddd0] font-mono text-sm">
                  CLAUDE.md
                </code>{" "}
                or{" "}
                <code className="bg-[#161b18] border border-[#2b483e] px-1.5 py-0.5 rounded text-[#c2ddd0] font-mono text-sm">
                  AGENTS.md
                </code>
                :
              </p>

              <Terminal
                title="AGENTS.md"
                language="markdown"
                code={`## agent-ci\n\n- Use \`npx @redwoodjs/agent-ci run --quiet --all\` to run CI locally\n- When a step fails, the run pauses automatically. Use \`npx @redwoodjs/agent-ci retry --name <runner>\` to retry after fixing the failure\n- Do NOT push to trigger remote CI when agent-ci can run it locally — it's instant and free\n- CI was green before you started. Any failure is caused by your changes — do not assume pre-existing failures\n- Use \`--no-matrix\` to collapse matrix jobs into a single run when you don't need full matrix coverage`}
              />
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="border-t border-[#2b483e] pt-8 mt-12 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2 text-[#71a792] font-mono text-sm">
            <TerminalIcon size={16} />
            <span>AGENT-CI // LOCAL RUNNER</span>
          </div>
          <div className="text-[#528b76] text-sm font-mono">
            Built by{" "}
            <a
              href="https://rwsdk.com"
              className="text-[#9bc5b3] hover:text-[#e0eee5] transition-colors underline decoration-[#34594c] underline-offset-4"
            >
              RedwoodJS
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
};
