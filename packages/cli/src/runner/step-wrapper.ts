// ─── Pause-on-failure step wrapping ───────────────────────────────────────────
//
// Wraps `run:` step scripts in a retry loop so the runner pauses on failure
// and waits for an external signal (retry / abort) before continuing.

/**
 * Wrap a bash script in the pause-on-failure retry loop.
 *
 * The wrapper:
 *  1. Checks for a `from-step` signal file — if present and this step's index
 *     is below the target, the step is skipped (exit 0). When the target is
 *     reached the signal file is removed so subsequent steps run normally.
 *  2. Runs the original script
 *  3. On success → exits 0
 *  4. On failure → writes a `paused` signal file, emits a `::error::` annotation,
 *     and polls until a `retry` or `abort` signal file appears.
 *
 * @param stepIndex  1-based index of this step across ALL steps (matches the UI numbering)
 */
export function wrapStepScript(script: string, stepName: string, stepIndex: number): string {
  // Escape single-quotes in the step name so it's safe inside the echo
  const safeName = stepName.replace(/'/g, "'\\''");
  // The original script runs in a subshell `( ... )` so that:
  //  1. `exit N` inside the script terminates the subshell, not the retry loop
  //  2. The runner's `set -e` (bash -e {0}) doesn't bypass the wrapper
  return `__SIGNALS="/tmp/agent-ci-signals"
__STEP_INDEX=${stepIndex}
# ── from-step skip logic ──
if [ -f "$__SIGNALS/from-step" ]; then
  __FROM_STEP=$(cat "$__SIGNALS/from-step")
  if [ "$__FROM_STEP" != '*' ] && [ "$__STEP_INDEX" -lt "$__FROM_STEP" ] 2>/dev/null; then
    echo "Skipping step $__STEP_INDEX (rewind target: step $__FROM_STEP)"
    exit 0
  fi
  rm -f "$__SIGNALS/from-step"
  echo "Resuming from step $__STEP_INDEX."
fi
__ATTEMPT=0
while true; do
  __ATTEMPT=$((__ATTEMPT + 1))
  set +e
  (
    ${script}
  )
  __EC=$?
  set -e
  if [ $__EC -eq 0 ]; then exit 0; fi
  printf '%s\\n%s\\n%s' '${safeName}' "$__ATTEMPT" "$__STEP_INDEX" > "$__SIGNALS/paused"
  echo "::error::Step failed (exit $__EC). Paused — waiting for retry signal."
  while [ ! -f "$__SIGNALS/retry" ] && [ ! -f "$__SIGNALS/abort" ]; do sleep 1; done
  if [ -f "$__SIGNALS/abort" ]; then rm -f "$__SIGNALS/abort" "$__SIGNALS/paused"; exit $__EC; fi
  rm -f "$__SIGNALS/retry" "$__SIGNALS/paused"
  echo "Retrying step..."
done`;
}

/**
 * Clone a steps array, wrapping `run:` steps when `pauseOnFailure` is enabled.
 *
 * Only steps with `Reference.Type === "Script"` (i.e. `run:` steps) are wrapped.
 * `uses:` steps are left untouched because the runner's action dispatcher handles
 * them internally and can't be wrapped at the shell level.
 *
 * Step indices are 1-based across ALL steps (matching the tree UI numbering),
 * not just the `run:` steps.
 */
export function wrapJobSteps(steps: any[], pauseOnFailure: boolean): any[] {
  if (!pauseOnFailure || !steps) {
    return steps;
  }

  return steps.map((step, idx) => {
    if (step?.Reference?.Type !== "Script" || !step?.Inputs?.script) {
      return step;
    }
    const stepIndex = idx + 1; // 1-based to match UI
    return {
      ...step,
      Inputs: {
        ...step.Inputs,
        script: wrapStepScript(
          step.Inputs.script,
          step.Name || step.DisplayName || "step",
          stepIndex,
        ),
      },
    };
  });
}
