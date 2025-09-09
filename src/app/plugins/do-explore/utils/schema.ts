export function extractColumnsFromCreate(sql: string): { name: string; type: string; references?: { table: string; column?: string; onDelete?: string; onUpdate?: string } }[] {
  // pull the first (...) group (columns + constraints)
  const m = sql.match(/\((.*)\)/s);
  if (!m) return [];
  const body = m[1];

  // split top-level comma-separated items (ignore commas inside parens)
  const parts: string[] = [];
  let level = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') level++;
    else if (ch === ')') level--;
    else if (ch === ',' && level === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(body.slice(start).trim());

  const isConstraint = (s: string) => /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i.test(s);

  type Col = { name: string; type: string; references?: { table: string; column?: string; onDelete?: string; onUpdate?: string } };
  const cols: Col[] = [];

  // Helper to parse a possibly quoted identifier
  function parseIdentifier(input: string | undefined): string | undefined {
    if (!input) return undefined;
    const m1 = input.match(/^"([^"]+)"$/); // "id"
    if (m1) return m1[1];
    const m2 = input.match(/^`([^`]+)`$/); // `id`
    if (m2) return m2[1];
    const m3 = input.match(/^\[([^\]]+)\]$/); // [id]
    if (m3) return m3[1];
    return input;
  }

  // First pass: collect columns and inline references
  for (const p of parts) {
    if (isConstraint(p)) continue;

    // 1) column name
    const nameMatch =
      p.match(/^\s*"([^"]+)"\s+/) || // "col"
      p.match(/^\s*`([^`]+)`\s+/) || // `col`
      p.match(/^\s*\[([^\]]+)\]\s+/) || // [col]
      p.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+/); // col
    if (!nameMatch) continue;
    const name = nameMatch[1];

    // 2) rest of definition
    const after = p.slice(nameMatch[0].length).trim();

    // 3) type (with optional parens)
    const typeMatch = after.match(/^([A-Za-z0-9_]+(?:\s*\([^)]*\))?)/);
    let type = typeMatch ? typeMatch[1] : '';
    type = type.replace(/\s+/g, ' ').trim();

    // 4) inline REFERENCES parsing
    let references: Col["references"] | undefined;
    const refMatch = after.match(/\breferences\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*))(?:\s*\(\s*((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*))\s*\))?/i);
    if (refMatch) {
      const tableRaw = refMatch[1];
      const columnRaw = refMatch[2];
      const table = parseIdentifier(tableRaw);
      const column = parseIdentifier(columnRaw);
      const onDelete = (after.match(/\bon\s+delete\s+(cascade|set\s+null|set\s+default|restrict|no\s+action)/i) || [])[1];
      const onUpdate = (after.match(/\bon\s+update\s+(cascade|set\s+null|set\s+default|restrict|no\s+action)/i) || [])[1];
      references = table ? { table, column, onDelete, onUpdate } : undefined;
    }

    cols.push({ name, type, references });
  }

  // Second pass: table-level FOREIGN KEY constraints
  for (const p of parts) {
    if (!/^(CONSTRAINT\b.*)?\s*FOREIGN\s+KEY\b/i.test(p)) continue;

    // FOREIGN KEY (col) REFERENCES table (refcol) [ON DELETE ...] [ON UPDATE ...]
    const keyColsMatch = p.match(/FOREIGN\s+KEY\s*\(([^)]+)\)/i);
    const refMatch = p.match(/REFERENCES\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*))(?:\s*\(([^)]+)\))?/i);

    if (!keyColsMatch || !refMatch) continue;

    // Split columns, handle single-column FKs primarily
    const keyCols = keyColsMatch[1].split(',').map((s) => parseIdentifier(s.trim().replace(/\s+/g, ' '))).filter(Boolean) as string[];
    const table = parseIdentifier(refMatch[1]);
    const refColsRaw = (refMatch[2] || '').split(',').map((s) => parseIdentifier(s.trim())).filter(Boolean) as string[];
    const onDelete = (p.match(/\bon\s+delete\s+(cascade|set\s+null|set\s+default|restrict|no\s+action)/i) || [])[1];
    const onUpdate = (p.match(/\bon\s+update\s+(cascade|set\s+null|set\s+default|restrict|no\s+action)/i) || [])[1];

    if (!table) continue;

    // Map each key column to its referenced column when available (single-column typical case)
    for (let i = 0; i < keyCols.length; i++) {
      const keyCol = keyCols[i];
      const refCol = refColsRaw[i];
      const col = cols.find((c) => c.name === keyCol);
      if (!col) continue;
      // Do not overwrite inline references if already present
      if (!col.references) {
        col.references = { table, column: refCol, onDelete, onUpdate };
      }
    }
  }

  return cols;
}
  
//   // Example:
//   const create = `CREATE TABLE "posts" (
//     "id" text primary key,
//     "userId" text not null references "users" ("id") on delete cascade,
//     "title" text not null,
//     "content" text
//   )`;
  
//   console.log(extractColumnsFromCreate(create));
//   // => [
//   //   { name: 'id', type: 'text' },
//   //   { name: 'userId', type: 'text' },
//   //   { name: 'title', type: 'text' },
//   //   { name: 'content', type: 'text' }
//   // ]