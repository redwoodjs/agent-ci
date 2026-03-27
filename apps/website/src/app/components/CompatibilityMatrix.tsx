const LEGEND = [
  { icon: "✅", label: "Supported" },
  { icon: "⚠️", label: "Partial" },
  { icon: "❌", label: "Not supported" },
  { icon: "🟡", label: "Ignored (no-op)" },
];

type Row = { key: string; status: string; notes?: string };

const SECTIONS: { label: string; rows: Row[] }[] = [
  {
    label: "Workflow",
    rows: [
      { key: "name", status: "✅" },
      { key: "run-name", status: "🟡", notes: "Parsed but not displayed" },
      {
        key: "on (push, pull_request)",
        status: "✅",
        notes: "Branch/path filters evaluated by --all",
      },
      {
        key: "on (schedule, workflow_dispatch)",
        status: "🟡",
        notes: "Accepted but triggers are not simulated",
      },
      { key: "on (workflow_call)", status: "❌", notes: "Reusable workflow calls not supported" },
      { key: "on (other events)", status: "🟡", notes: "Parsed, not simulated" },
      { key: "env", status: "✅", notes: "Workflow-level env propagated to steps" },
      { key: "defaults.run.shell", status: "✅", notes: "Passed through to the runner" },
      {
        key: "defaults.run.working-directory",
        status: "✅",
        notes: "Passed through to the runner",
      },
      { key: "permissions", status: "🟡", notes: "Accepted, not enforced (mock GITHUB_TOKEN)" },
      {
        key: "concurrency",
        status: "❌",
        notes:
          "Concurrency groups are a server-side queue/cancel mechanism; there is no persistent local server to coordinate across runs",
      },
    ],
  },
  {
    label: "Jobs",
    rows: [
      { key: "jobs.<id>", status: "✅", notes: "Multiple jobs in a single workflow" },
      { key: "jobs.<id>.name", status: "✅" },
      { key: "jobs.<id>.needs", status: "✅", notes: "Topological sort into dependency waves" },
      {
        key: "jobs.<id>.if",
        status: "⚠️",
        notes: "Simplified evaluator: always(), success(), failure(), ==/!=, &&/||",
      },
      {
        key: "jobs.<id>.runs-on",
        status: "🟡",
        notes: "Accepted; always runs in a Linux container",
      },
      { key: "jobs.<id>.environment", status: "🟡", notes: "Accepted, not enforced" },
      { key: "jobs.<id>.env", status: "✅" },
      { key: "jobs.<id>.defaults.run", status: "✅", notes: "shell, working-directory" },
      {
        key: "jobs.<id>.outputs",
        status: "✅",
        notes: "Resolved via resolveJobOutputs, accumulated across waves",
      },
      { key: "jobs.<id>.timeout-minutes", status: "❌" },
      { key: "jobs.<id>.continue-on-error", status: "❌" },
      { key: "jobs.<id>.concurrency", status: "❌", notes: "See workflow-level concurrency" },
      {
        key: "jobs.<id>.container",
        status: "✅",
        notes: "Short & long form; image, env, ports, volumes, options",
      },
      {
        key: "jobs.<id>.services",
        status: "✅",
        notes: "Sidecar containers with image, env, ports, options",
      },
      { key: "jobs.<id>.uses (reusable workflows)", status: "❌" },
      { key: "jobs.<id>.secrets", status: "❌", notes: "Use .env.agent-ci file instead" },
    ],
  },
  {
    label: "Strategy",
    rows: [
      { key: "strategy.matrix", status: "✅", notes: "Cartesian product expansion" },
      { key: "strategy.matrix.include", status: "❌" },
      { key: "strategy.matrix.exclude", status: "❌" },
      { key: "strategy.fail-fast", status: "✅", notes: "Respects false to continue on failure" },
      {
        key: "strategy.max-parallel",
        status: "❌",
        notes: "Controlled by host concurrency, not per-job",
      },
    ],
  },
  {
    label: "Steps",
    rows: [
      { key: "steps[*].id", status: "✅" },
      { key: "steps[*].name", status: "✅", notes: "Expression expansion in names" },
      {
        key: "steps[*].if",
        status: "⚠️",
        notes: "Evaluated by runner; steps.*.outputs.cache-hit resolves to empty string",
      },
      { key: "steps[*].run", status: "✅", notes: "Multiline scripts, ${{ }} expansion" },
      { key: "steps[*].uses", status: "✅", notes: "Public actions downloaded via GitHub API" },
      {
        key: "steps[*].uses (local, e.g. ./)",
        status: "❌",
        notes:
          "Local actions defined within the repo are not supported; agent-ci fails fast with a clear error",
      },
      { key: "steps[*].with", status: "✅", notes: "Expression expansion in values" },
      { key: "steps[*].env", status: "✅", notes: "Expression expansion in values" },
      { key: "steps[*].working-directory", status: "✅" },
      { key: "steps[*].shell", status: "✅", notes: "Passed through to the runner" },
      { key: "steps[*].continue-on-error", status: "❌" },
      { key: "steps[*].timeout-minutes", status: "❌" },
    ],
  },
  {
    label: "Expressions",
    rows: [
      { key: "hashFiles(...)", status: "✅", notes: "SHA-256 of matching files, multi-glob" },
      { key: "format(...)", status: "✅", notes: "Template substitution with recursive expansion" },
      { key: "matrix.*", status: "✅" },
      { key: "secrets.*", status: "✅", notes: "Via .env.agent-ci file" },
      { key: "runner.os", status: "✅", notes: "Always returns Linux" },
      { key: "runner.arch", status: "✅", notes: "Always returns X64" },
      {
        key: "github.sha, github.ref_name, etc.",
        status: "⚠️",
        notes: "Returns static/dummy values",
      },
      { key: "github.event.*", status: "⚠️", notes: "Returns empty strings" },
      { key: "strategy.job-total, strategy.job-index", status: "✅" },
      { key: "steps.*.outputs.*", status: "⚠️", notes: "Resolves to empty string at parse time" },
      { key: "needs.*.outputs.*", status: "⚠️", notes: "Resolved from needsContext when provided" },
      {
        key: "Boolean/comparison operators",
        status: "⚠️",
        notes: "==, !=, &&, || in job-level if",
      },
      { key: "toJSON, fromJSON", status: "✅" },
      { key: "contains, startsWith, endsWith", status: "❌" },
      {
        key: "success(), failure(), always(), cancelled()",
        status: "✅",
        notes: "Evaluated by Agent CI for job-level if",
      },
    ],
  },
  {
    label: "GitHub API",
    rows: [
      { key: "Action downloads", status: "✅", notes: "Resolves tarballs from github.com" },
      {
        key: "actions/cache",
        status: "✅",
        notes: "Local filesystem cache with bind-mount fast path",
      },
      {
        key: "actions/checkout",
        status: "✅",
        notes: "Workspace is rsynced; configured with clean: false",
      },
      {
        key: "actions/setup-node, actions/setup-python, etc.",
        status: "✅",
        notes: "Run natively within the runner",
      },
      {
        key: "actions/upload-artifact / download-artifact",
        status: "✅",
        notes: "Local filesystem storage",
      },
      { key: "GITHUB_TOKEN", status: "✅", notes: "Mock token, all API calls answered locally" },
      {
        key: "Workflow commands (::set-output::, ::error::, etc.)",
        status: "✅",
        notes: "Handled by the runner",
      },
    ],
  },
];

export function CompatibilityMatrix() {
  return (
    <div className="space-y-10">
      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs font-mono text-[#71a792]">
        {LEGEND.map(({ icon, label }) => (
          <span key={label} className="flex items-center gap-1.5">
            <span>{icon}</span>
            <span>{label}</span>
          </span>
        ))}
      </div>

      {SECTIONS.map((section) => (
        <div key={section.label}>
          <h2 className="font-mono text-xs uppercase tracking-wider text-[#e0eee5] mb-0 px-4 py-2 bg-[#12211c] border border-b-0 border-[#2b483e] inline-block">
            {section.label}
          </h2>
          <div className="overflow-x-auto border border-[#2b483e] bg-[#0d110f]">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#34594c] bg-[#12211c]">
                  <th className="py-3 px-4 font-mono text-xs text-[#71a792] uppercase tracking-wider w-1/2">
                    Key
                  </th>
                  <th className="py-3 px-4 font-mono text-xs text-[#71a792] uppercase tracking-wider w-16">
                    Status
                  </th>
                  <th className="py-3 px-4 font-mono text-xs text-[#71a792] uppercase tracking-wider">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {section.rows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-[#1a2822] hover:bg-[#12211c] transition-colors"
                  >
                    <td className="py-3 px-4 font-mono text-[#c2ddd0] text-xs">{row.key}</td>
                    <td className="py-3 px-4 text-center text-base">{row.status}</td>
                    <td className="py-3 px-4 text-[#71a792] text-xs">{row.notes || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
