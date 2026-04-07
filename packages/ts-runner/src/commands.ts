/**
 * GitHub Actions workflow command parser.
 *
 * Parses `::` commands from step stdout and file-based commands
 * from $GITHUB_OUTPUT, $GITHUB_ENV, $GITHUB_PATH.
 *
 * Reference: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions
 */

import fs from "fs";

// ---------------------------------------------------------------------------
// Workflow commands (stdout `::` protocol)
// ---------------------------------------------------------------------------

export interface Annotation {
  level: "error" | "warning" | "notice";
  message: string;
  file?: string;
  line?: number;
  endLine?: number;
  col?: number;
  endColumn?: number;
  title?: string;
}

export interface WorkflowCommands {
  outputs: Record<string, string>;
  env: Record<string, string>;
  path: string[];
  annotations: Annotation[];
  masks: string[];
  debugMessages: string[];
  /** If ::stop-commands:: is active, this contains the token. */
  stopToken: string | null;
}

/**
 * Parse workflow commands from a single line of stdout.
 *
 * Mutates the provided `state` object with the parsed results.
 * Returns the line with commands stripped (for display), or null if
 * the line should be hidden (debug messages when debug is off).
 */
export function parseCommand(line: string, state: WorkflowCommands): string | null {
  // If stop-commands is active, only look for the resume token
  if (state.stopToken) {
    if (line === `::${state.stopToken}::`) {
      state.stopToken = null;
      return null;
    }
    return line; // Pass through — commands are disabled
  }

  // ::set-output name=<name>::<value> (deprecated but still used)
  const setOutputMatch = line.match(/^::set-output name=([^:]+)::(.*)$/);
  if (setOutputMatch) {
    state.outputs[setOutputMatch[1]] = setOutputMatch[2];
    return null;
  }

  // ::error <props>::<message>
  const errorMatch = line.match(/^::error\s*(.*?)::(.*)$/);
  if (errorMatch) {
    state.annotations.push({
      level: "error",
      ...parseAnnotationProps(errorMatch[1]),
      message: errorMatch[2],
    });
    return line;
  }

  // ::warning <props>::<message>
  const warningMatch = line.match(/^::warning\s*(.*?)::(.*)$/);
  if (warningMatch) {
    state.annotations.push({
      level: "warning",
      ...parseAnnotationProps(warningMatch[1]),
      message: warningMatch[2],
    });
    return line;
  }

  // ::notice <props>::<message>
  const noticeMatch = line.match(/^::notice\s*(.*?)::(.*)$/);
  if (noticeMatch) {
    state.annotations.push({
      level: "notice",
      ...parseAnnotationProps(noticeMatch[1]),
      message: noticeMatch[2],
    });
    return line;
  }

  // ::debug::<message>
  const debugMatch = line.match(/^::debug::(.*)$/);
  if (debugMatch) {
    state.debugMessages.push(debugMatch[1]);
    return null;
  }

  // ::group::<name>
  if (line.startsWith("::group::")) {
    return line; // Pass through for display
  }

  // ::endgroup::
  if (line === "::endgroup::") {
    return line;
  }

  // ::add-mask::<value>
  const maskMatch = line.match(/^::add-mask::(.*)$/);
  if (maskMatch) {
    state.masks.push(maskMatch[1]);
    return null;
  }

  // ::stop-commands::<token>
  const stopMatch = line.match(/^::stop-commands::(.+)$/);
  if (stopMatch) {
    state.stopToken = stopMatch[1];
    return null;
  }

  return line;
}

function parseAnnotationProps(propsStr: string): Partial<Annotation> {
  const props: Partial<Annotation> = {};
  if (!propsStr.trim()) {
    return props;
  }

  for (const pair of propsStr.split(",")) {
    const [key, ...rest] = pair.split("=");
    const value = rest.join("=");
    switch (key.trim()) {
      case "file":
        props.file = value;
        break;
      case "line":
        props.line = parseInt(value, 10) || undefined;
        break;
      case "endLine":
        props.endLine = parseInt(value, 10) || undefined;
        break;
      case "col":
        props.col = parseInt(value, 10) || undefined;
        break;
      case "endColumn":
        props.endColumn = parseInt(value, 10) || undefined;
        break;
      case "title":
        props.title = value;
        break;
    }
  }
  return props;
}

export function createEmptyCommands(): WorkflowCommands {
  return {
    outputs: {},
    env: {},
    path: [],
    annotations: [],
    masks: [],
    debugMessages: [],
    stopToken: null,
  };
}

// ---------------------------------------------------------------------------
// File-based commands ($GITHUB_OUTPUT, $GITHUB_ENV, $GITHUB_PATH)
// ---------------------------------------------------------------------------

/**
 * Parse a GITHUB_OUTPUT or GITHUB_ENV file.
 *
 * Format:
 *   name=value        (single-line)
 *   name<<EOF         (multi-line)
 *   value line 1
 *   value line 2
 *   EOF
 */
export function parseKeyValueFile(filePath: string): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }

  const result: Record<string, string> = {};
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Multi-line: name<<DELIMITER
    const multiMatch = line.match(/^([^=]+)<<(.+)$/);
    if (multiMatch) {
      const name = multiMatch[1];
      const delimiter = multiMatch[2];
      const valueLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i]);
        i++;
      }
      result[name] = valueLines.join("\n");
      i++; // skip delimiter line
      continue;
    }

    // Single-line: name=value
    const eqIndex = line.indexOf("=");
    if (eqIndex > 0) {
      const name = line.slice(0, eqIndex);
      const value = line.slice(eqIndex + 1);
      result[name] = value;
    }

    i++;
  }

  return result;
}

/**
 * Parse a GITHUB_PATH file.
 *
 * One path per line, prepended to PATH for subsequent steps.
 */
export function parsePathFile(filePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
