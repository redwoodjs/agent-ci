// ─── Diff Renderer ────────────────────────────────────────────────────────────
// Lightweight terminal renderer that diffs output line-by-line and only
// rewrites changed lines. For a 30-line tree where only 2–3 spinner chars
// change per frame, this skips ~90% of the ANSI escape traffic that
// log-update's full erase-and-rewrite approach would produce.
//
// Cursor movement uses explicit CSI sequences (CUU/CUD) instead of \n to
// avoid ambiguity with terminal onlcr/raw-mode settings.

const ESC = "\x1b";
const CUD1 = `${ESC}[1B`; // cursor down 1 row (no scroll, no CR)
const SYNC_START = `${ESC}[?2026h`; // DEC synchronized output — begin
const SYNC_END = `${ESC}[?2026l`; // DEC synchronized output — end

export interface DiffRenderer {
  /** Diff-render the output, only updating changed lines. */
  update(output: string): void;
  /** Persist the current output and restore the cursor. */
  done(): void;
}

export function createDiffRenderer(): DiffRenderer {
  let prevLines: string[] = [];
  let lastOutput = "";

  // Ensure cursor is always restored, even on unexpected exit
  const restoreCursor = () => process.stdout.write(`${ESC}[?25h`);
  process.on("exit", restoreCursor);

  return {
    update(output: string) {
      // Completely identical → skip all work
      if (output === lastOutput) {
        return;
      }
      lastOutput = output;

      const newLines = output.split("\n");

      // First render: hide cursor, write everything
      if (prevLines.length === 0) {
        process.stdout.write(`${ESC}[?25l${output}\n`);
        prevLines = newLines;
        return;
      }

      // Begin synchronized update — terminal buffers all changes and
      // repaints once at SYNC_END, eliminating mid-frame flicker.
      // Terminals that don't support DEC sync silently ignore the markers.
      let buf = `${SYNC_START}${ESC}[${prevLines.length}A\r`;

      // Diff lines that exist in both old and new output.
      // Use CUD1+\r for movement — never bare \n — so column is always 0.
      const commonLen = Math.min(prevLines.length, newLines.length);
      for (let i = 0; i < commonLen; i++) {
        if (prevLines[i] === newLines[i]) {
          buf += `${CUD1}\r`; // skip unchanged line
        } else {
          buf += `${ESC}[2K${newLines[i]}${CUD1}\r`; // clear, write, next row col 0
        }
      }

      // Output grew — append new lines (need \n to create new terminal rows)
      for (let i = commonLen; i < newLines.length; i++) {
        buf += `${ESC}[2K${newLines[i]}\n`;
      }

      // Output shrank — clear leftover lines, then reposition cursor
      if (newLines.length < prevLines.length) {
        for (let i = commonLen; i < prevLines.length; i++) {
          buf += `${ESC}[2K${CUD1}\r`;
        }
        buf += `${ESC}[${prevLines.length - newLines.length}A\r`;
      }

      buf += SYNC_END;
      process.stdout.write(buf);
      prevLines = newLines;
    },

    done() {
      process.stdout.write(`${ESC}[?25h\n`);
      process.removeListener("exit", restoreCursor);
      prevLines = [];
      lastOutput = "";
    },
  };
}
