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
      { key: "run-name", status: "🟡", notes: "Parsed but not displayed anywhere" },
      {
        key: "on (push, pull_request)",
        status: "✅",
        notes: "Branch and path filters are evaluated when using --all",
      },
      {
        key: "on (schedule, workflow_dispatch)",
        status: "🟡",
        notes:
          "Accepted without error, but Agent CI does not simulate event triggers — workflows must be run manually",
      },
      {
        key: "on (workflow_call)",
        status: "❌",
        notes:
          "Reusable workflows would require downloading and parsing external workflow files, nested job orchestration, and cross-workflow output passing — a significant architectural change",
      },
      {
        key: "on (other events)",
        status: "🟡",
        notes: "Parsed without error, but the event is not simulated",
      },
      { key: "env", status: "✅", notes: "Workflow-level env is propagated to all steps" },
      { key: "defaults.run.shell", status: "✅", notes: "Passed through to the runner" },
      {
        key: "defaults.run.working-directory",
        status: "✅",
        notes: "Passed through to the runner",
      },
      {
        key: "permissions",
        status: "🟡",
        notes: "Accepted but not enforced — the mock GITHUB_TOKEN has full access",
      },
      {
        key: "concurrency",
        status: "❌",
        notes:
          "Concurrency groups are a GitHub-side queuing and cancellation mechanism. Agent CI has no persistent server to track group state across runs, so this cannot be implemented locally",
      },
    ],
  },
  {
    label: "Jobs",
    rows: [
      { key: "jobs.<id>", status: "✅", notes: "Multiple jobs in a single workflow" },
      { key: "jobs.<id>.name", status: "✅" },
      {
        key: "jobs.<id>.needs",
        status: "✅",
        notes: "Jobs are sorted topologically into dependency waves",
      },
      {
        key: "jobs.<id>.if",
        status: "⚠️",
        notes:
          "Supported: success(), failure(), always(), cancelled(), == / !=, && / ||, needs.*.outputs.*, needs.*.result. Not supported: contains(), startsWith(), endsWith(), and other expression functions",
      },
      {
        key: "jobs.<id>.runs-on",
        status: "🟡",
        notes: "Accepted but always runs in a Linux container regardless of the value",
      },
      {
        key: "jobs.<id>.environment",
        status: "🟡",
        notes: "Accepted but not enforced — environment protection rules are GitHub-side only",
      },
      { key: "jobs.<id>.env", status: "✅" },
      { key: "jobs.<id>.defaults.run", status: "✅", notes: "shell and working-directory" },
      {
        key: "jobs.<id>.outputs",
        status: "✅",
        notes: "Resolved after each job completes and accumulated across dependency waves",
      },
      {
        key: "jobs.<id>.timeout-minutes",
        status: "❌",
        notes:
          "Not implemented. Agent CI's pause-on-failure model is the intended way to handle long-running steps — a hard timeout would destroy the container state that makes local debugging possible",
      },
      {
        key: "jobs.<id>.continue-on-error",
        status: "❌",
        notes:
          "Not implemented. Agent CI pauses on failure so you can inspect and fix the container in place; continue-on-error would skip past failures and discard that debugging opportunity",
      },
      {
        key: "jobs.<id>.concurrency",
        status: "❌",
        notes: "See workflow-level concurrency above",
      },
      {
        key: "jobs.<id>.container",
        status: "✅",
        notes: "Short and long form; image, env, ports, volumes, and options are all supported",
      },
      {
        key: "jobs.<id>.services",
        status: "✅",
        notes: "Sidecar containers with image, env, ports, and options",
      },
      {
        key: "jobs.<id>.uses (reusable workflows)",
        status: "❌",
        notes: "See on (workflow_call) above — same architectural limitation",
      },
      {
        key: "jobs.<id>.secrets",
        status: "❌",
        notes:
          "Agent CI cannot access GitHub's secret storage. Use a .env.agent-ci file at the project root instead — secrets are loaded from there and injected as ${{ secrets.* }} expressions",
      },
    ],
  },
  {
    label: "Strategy",
    rows: [
      {
        key: "strategy.matrix",
        status: "✅",
        notes: "Cartesian product of all array values is fully expanded",
      },
      {
        key: "strategy.matrix.include",
        status: "❌",
        notes:
          "Not implemented. The matrix parser only processes array-valued keys; include entries (which are objects) are silently dropped. Adding support would require post-processing the Cartesian product",
      },
      {
        key: "strategy.matrix.exclude",
        status: "❌",
        notes:
          "Not implemented — same reason as include. exclude entries are objects and are dropped by the array-only parser",
      },
      {
        key: "strategy.fail-fast",
        status: "✅",
        notes: "Setting fail-fast: false allows remaining matrix jobs to continue after a failure",
      },
      {
        key: "strategy.max-parallel",
        status: "❌",
        notes:
          "Not implemented. Parallelism is controlled by Agent CI's host-level concurrency limiter (based on CPU count), not per-workflow job limits",
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
        notes:
          "The condition is passed to the official runner binary, which evaluates it at runtime. Limitation: steps.*.outputs.cache-hit and similar outputs resolve to an empty string at parse time because prior steps have not yet run when the workflow is parsed",
      },
      {
        key: "steps[*].run",
        status: "✅",
        notes: "Multiline shell scripts with ${{ }} expression expansion",
      },
      {
        key: "steps[*].uses",
        status: "✅",
        notes: "Public actions are downloaded via the GitHub API",
      },
      {
        key: "steps[*].uses (local, e.g. ./)",
        status: "❌",
        notes:
          "Local actions defined inside the repo are not supported. Agent CI fails immediately with a clear error rather than silently producing wrong results",
      },
      { key: "steps[*].with", status: "✅", notes: "Expression expansion in values" },
      { key: "steps[*].env", status: "✅", notes: "Expression expansion in values" },
      { key: "steps[*].working-directory", status: "✅" },
      { key: "steps[*].shell", status: "✅", notes: "Passed through to the runner" },
      {
        key: "steps[*].continue-on-error",
        status: "❌",
        notes: "Not implemented — see jobs.<id>.continue-on-error above for the reasoning",
      },
      {
        key: "steps[*].timeout-minutes",
        status: "❌",
        notes: "Not implemented — see jobs.<id>.timeout-minutes above for the reasoning",
      },
    ],
  },
  {
    label: "Expressions",
    rows: [
      {
        key: "hashFiles(...)",
        status: "✅",
        notes: "SHA-256 of matching files; supports multiple glob patterns",
      },
      {
        key: "format(...)",
        status: "✅",
        notes: "Template substitution with recursive expression expansion",
      },
      { key: "matrix.*", status: "✅" },
      { key: "secrets.*", status: "✅", notes: "Loaded from .env.agent-ci at the project root" },
      { key: "runner.os", status: "✅", notes: "Always returns Linux" },
      { key: "runner.arch", status: "✅", notes: "Always returns X64" },
      {
        key: "github.sha, github.ref_name, etc.",
        status: "⚠️",
        notes:
          "Returns hardcoded dummy values: sha is all zeros, ref_name and head_ref are 'main', repository is 'local/repo', actor is 'local', run_id and run_number are '1'. These are safe defaults that won't break most expressions but will not reflect actual repo state",
      },
      {
        key: "github.event.*",
        status: "⚠️",
        notes:
          "All event payload fields (pull_request.number, pull_request.title, etc.) return empty strings. No real webhook event is triggered locally",
      },
      { key: "strategy.job-total, strategy.job-index", status: "✅" },
      {
        key: "steps.*.outputs.*",
        status: "⚠️",
        notes:
          "Resolves to an empty string at parse time. The official runner evaluates these correctly at runtime — the limitation only affects Agent CI's own expression pre-processing",
      },
      {
        key: "needs.*.outputs.*",
        status: "✅",
        notes:
          "Resolved after dependency jobs complete. The needs context is built from actual job outputs and passed into subsequent job evaluation",
      },
      {
        key: "Boolean/comparison operators",
        status: "⚠️",
        notes:
          "Supported in job-level if: ==, !=, &&, ||, parentheses. Not supported: unary ! (not), numeric comparisons (<, >, <=, >=)",
      },
      { key: "toJSON, fromJSON", status: "✅" },
      {
        key: "contains, startsWith, endsWith",
        status: "❌",
        notes:
          "Not implemented in the expression parser. The evaluator handles context lookups and comparison operators but does not support arbitrary function calls with string arguments",
      },
      {
        key: "success(), failure(), always(), cancelled()",
        status: "✅",
        notes: "Evaluated by Agent CI for job-level if conditions",
      },
    ],
  },
  {
    label: "GitHub API",
    rows: [
      {
        key: "Action downloads",
        status: "✅",
        notes: "Action tarballs are resolved and downloaded from github.com",
      },
      {
        key: "actions/cache",
        status: "✅",
        notes:
          "Cache is stored on the local filesystem via bind-mount, giving ~0 ms round-trip on cache hits",
      },
      {
        key: "actions/checkout",
        status: "✅",
        notes:
          "The workspace is rsynced into the container with clean: false to preserve local changes",
      },
      {
        key: "actions/setup-node, actions/setup-python, etc.",
        status: "✅",
        notes: "Tool setup actions run natively inside the runner container",
      },
      {
        key: "actions/upload-artifact / download-artifact",
        status: "✅",
        notes: "Artifacts are stored on the local filesystem",
      },
      {
        key: "GITHUB_TOKEN",
        status: "✅",
        notes:
          "A mock token is injected; all GitHub API calls from the runner are answered locally by Agent CI's API emulation layer",
      },
      {
        key: "Workflow commands (::set-output::, ::error::, etc.)",
        status: "✅",
        notes: "Handled by the official runner binary",
      },
    ],
  },
];

function SectionTable({ label, rows }: { label: string; rows: Row[] }) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-[#e0eee5] font-serif mb-4">{label}</h2>
      <div className="overflow-x-auto border border-[#2b483e] bg-[#0d110f] mb-12">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[#34594c] bg-[#12211c]">
              <th className="py-3 px-4 font-mono text-xs text-[#71a792] uppercase tracking-wider w-1/3">
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
            {rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-[#1a2822] hover:bg-[#12211c] transition-colors"
              >
                <td className="py-3 px-4 font-mono text-[#c2ddd0] text-xs align-top">{row.key}</td>
                <td className="py-3 px-4 text-center text-base align-top">{row.status}</td>
                <td className="py-3 px-4 text-[#71a792] text-xs align-top">{row.notes || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CompatibilityMatrix() {
  return (
    <div>
      {/* Legend */}
      <div className="flex flex-wrap gap-4 mb-10 text-xs font-mono text-[#71a792]">
        {LEGEND.map(({ icon, label }) => (
          <span key={label} className="flex items-center gap-1.5">
            <span>{icon}</span>
            <span>{label}</span>
          </span>
        ))}
      </div>

      {SECTIONS.map((s) => (
        <SectionTable key={s.label} label={s.label} rows={s.rows} />
      ))}
    </div>
  );
}
