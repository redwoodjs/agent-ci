// Shared aggregation + markdown rendering. Used by both run.mjs (live eval)
// and rescore.mjs (replay saved transcripts).

export function aggregate({ variant, fixture, trials }) {
  const n = trials.length;
  if (n === 0) {
    return { variant, fixture, n, perItem: [], fullRubricPasses: 0, ciPasses: 0, trials: [] };
  }
  const rubricIds = trials[0].rubric.map((r) => r.id);
  const perItem = rubricIds.map((id) => {
    const passes = trials.filter((t) => t.rubric.find((r) => r.id === id)?.pass).length;
    return { id, passes, trials: n, rate: passes / n };
  });
  const fullRubricPasses = trials.filter((t) => t.rubric.every((r) => r.pass)).length;
  const ciPasses = trials.filter((t) => t.groundTruth?.passed).length;
  return { variant, fixture, n, perItem, fullRubricPasses, ciPasses, trials };
}

export function renderMarkdown(cells, { heading = "Scorecard" } = {}) {
  const variants = [...new Set(cells.map((c) => c.variant))];
  const fixtures = [...new Set(cells.map((c) => c.fixture))];
  const lines = [];
  const n = cells[0]?.n ?? 0;
  lines.push(`# ${heading} (N=${n} trials/cell)\n`);
  const header = ["fixture", ...variants];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const fx of fixtures) {
    const row = [fx];
    for (const v of variants) {
      const c = cells.find((x) => x.variant === v && x.fixture === fx);
      if (!c) {
        row.push("—");
        continue;
      }
      row.push(`${c.fullRubricPasses}/${c.n} · CI ${c.ciPasses}/${c.n}`);
    }
    lines.push(`| ${row.join(" | ")} |`);
  }

  lines.push("\n## Per-rubric-item pass rates\n");
  for (const fx of fixtures) {
    lines.push(`### ${fx}\n`);
    const ids = cells.find((c) => c.fixture === fx)?.perItem.map((p) => p.id) ?? [];
    const subHeader = ["item", ...variants];
    lines.push(`| ${subHeader.join(" | ")} |`);
    lines.push(`| ${subHeader.map(() => "---").join(" | ")} |`);
    for (const id of ids) {
      const row = [id];
      for (const v of variants) {
        const c = cells.find((x) => x.variant === v && x.fixture === fx);
        const p = c?.perItem.find((x) => x.id === id);
        row.push(p ? `${p.passes}/${p.trials}` : "—");
      }
      lines.push(`| ${row.join(" | ")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
