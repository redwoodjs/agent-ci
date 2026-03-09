// ─── Pause-on-failure step wrapping ───────────────────────────────────────────
//
// Wraps `run:` step scripts in a retry loop so the runner pauses on failure
// and waits for an external signal (retry / abort) before continuing.

/**
 * Wrap a bash script in the pause-on-failure retry loop.
 *
 * The wrapper:
 *  1. Runs the original script
 *  2. On success → exits 0
 *  3. On failure → writes a `paused` signal file, emits a `::error::` annotation,
 *     and polls until a `retry` or `abort` signal file appears.
 */
export function wrapStepScript(script: string, stepName: string): string {
  // Escape single-quotes in the step name so it's safe inside the echo
  const safeName = stepName.replace(/'/g, "'\\''");
  // The original script runs in a subshell `( ... )` so that:
  //  1. `exit N` inside the script terminates the subshell, not the retry loop
  //  2. The runner's `set -e` (bash -e {0}) doesn't bypass the wrapper
  return `__SIGNALS="/tmp/machinen-signals"
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
  printf '%s\\n%s' '${safeName}' "$__ATTEMPT" > "$__SIGNALS/paused"
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
 */
export function wrapJobSteps(steps: any[], pauseOnFailure: boolean): any[] {
  if (!pauseOnFailure || !steps) {
    return steps;
  }

  return steps.map((step) => {
    if (step?.Reference?.Type !== "Script" || !step?.Inputs?.script) {
      return step;
    }
    return {
      ...step,
      Inputs: {
        ...step.Inputs,
        script: wrapStepScript(step.Inputs.script, step.Name || step.DisplayName || "step"),
      },
    };
  });
}
