#!/usr/bin/env node
// Generate packages/cli/compatibility.md from compatibility.json.
// The JSON is the source of truth; run `pnpm compat:gen` after editing it.
// `--check` exits non-zero if the on-disk .md differs from what the JSON produces.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(__dirname, "../packages/cli");
const jsonPath = resolve(cliDir, "compatibility.json");
const mdPath = resolve(cliDir, "compatibility.md");

const data = JSON.parse(await readFile(jsonPath, "utf8"));

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const isWideGrapheme = (g) => {
  for (const ch of g) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x2600 && cp <= 0x27bf) || cp >= 0x1f000) {
      return true;
    }
  }
  return false;
};
const visualWidth = (s) => {
  let w = 0;
  for (const { segment } of segmenter.segment(s)) {
    w += isWideGrapheme(segment) ? 2 : 1;
  }
  return w;
};

const escapeCell = (s) => s.replace(/\|/g, "\\|");
const pad = (s, width) => s + " ".repeat(Math.max(0, width - visualWidth(s)));

function renderTable(rows) {
  const header = ["Key", "Status", "Notes"];
  const cells = rows.map((row) => [
    escapeCell(row.key),
    data.legend[row.status].icon,
    escapeCell(row.notes || ""),
  ]);
  const widths = header.map((h, i) =>
    Math.max(visualWidth(h), ...cells.map((row) => visualWidth(row[i]))),
  );
  const line = (row) => `| ${row.map((c, i) => pad(c, widths[i])).join(" | ")} |`;
  const sep = `| ${widths.map((w) => "-".repeat(Math.max(3, w))).join(" | ")} |`;
  return [line(header), sep, ...cells.map(line)].join("\n");
}

const legendLine = Object.values(data.legend)
  .map((l) => `${l.icon} = ${l.label}`)
  .join(" &nbsp; ");

const parts = ["# YAML Compatibility", "", data.intro, "", legendLine, ""];

for (const section of data.sections) {
  parts.push(`## ${section.title}`);
  parts.push("");
  parts.push(renderTable(section.rows));
  parts.push("");
}

const output = parts.join("\n").replace(/\n+$/, "") + "\n";

if (process.argv.includes("--check")) {
  const existing = await readFile(mdPath, "utf8").catch(() => "");
  if (existing !== output) {
    console.error(
      `compatibility.md is out of sync with compatibility.json.\nRun \`pnpm compat:gen\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log("compatibility.md is in sync with compatibility.json");
} else {
  await writeFile(mdPath, output);
  console.log(`wrote ${mdPath}`);
}
