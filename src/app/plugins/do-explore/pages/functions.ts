"use server";

import { rawDiscordDb as db } from "@/app/ingestors/discord/db";
import { env } from "cloudflare:workers";

export async function seedTable(tableName: string) {
    const adb: any = db;
    // check if there is a sqlite_master table
    const hasMasterTable = await adb.selectFrom("sqlite_master").selectAll().execute();
    if (!hasMasterTable) {
        throw new Error("SQLite master table not found");
    }
    const masterRows = await adb.selectFrom("sqlite_master").selectAll().execute();
    const table = masterRows.find((row: any) => row.name === tableName);

    if (!table) {
        throw new Error(`Table ${tableName} not found`);
    }
    // CREATE TABLE "posts" ("id" text primary key, "userId" text not null references "users" ("id"), "title" text not null, "content" text)
    const schemaMatch = (table.sql || "").match(/\((.*)\)/s);
    const schema = schemaMatch ? schemaMatch[1] : "";

    // Parse references to gather allowed FK values before generation
    const { extractColumnsFromCreate } = await import("../utils/schema");
    const columnsMeta = extractColumnsFromCreate(table.sql || "");
    type RefInfo = { column: string; table: string; targetColumn: string };
    const refs: RefInfo[] = columnsMeta
      .filter((c: any) => c.references?.table)
      .map((c: any) => ({
        column: c.name,
        table: String(c.references!.table),
        targetColumn: String(c.references!.column || "id"),
      }));

    const fkOptions: Record<string, string[]> = {};
    for (const { column, table, targetColumn } of refs) {
      try {
        const rows = await adb.selectFrom(table).select([targetColumn]).execute();
        fkOptions[column] = rows.map((r: any) => String(r[targetColumn]));
      } catch {
        fkOptions[column] = [];
      }
    }
    // If there are refs but no options, instruct to seed parents first
    const missingParents = Object.entries(fkOptions)
      .filter(([, opts]) => (opts?.length ?? 0) === 0)
      .map(([col]) => col);
    if (refs.length > 0 && missingParents.length > 0) {
      const parentTables = Array.from(new Set(refs.map((r) => r.table))).join(", ");
      throw new Error(
        `Cannot seed ${tableName}: referenced tables (${parentTables}) have no rows. Seed parent tables first.`
      );
    }
    // @ts-ignore
    const ai = env.AI;
    function extractJsonArrayFromText(text: string) {
        const startIdx = text.indexOf("[");
        const endIdx = text.lastIndexOf("]");
        if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
            throw new Error("AI response did not contain a JSON array");
        }
        const candidate = text.slice(startIdx, endIdx + 1);
        return JSON.parse(candidate);
    }
    function parseColumnTypes(schema: string): Record<string, string> {
        const columnNameToType: Record<string, string> = {};
        schema.split(",").forEach((segment) => {
            const match = segment.trim().match(/"([^"]+)"\s+([a-zA-Z]+)/);
            if (match) {
                const [, colName, colType] = match;
                columnNameToType[colName] = colType.toLowerCase();
            }
        });
        return columnNameToType;
    }
    function coerceRowTypes(row: any, columnTypes: Record<string, string>) {
        const coerced: any = { ...row };
        for (const [columnName, columnType] of Object.entries(columnTypes)) {
            if (columnType === "text" && columnName in coerced && coerced[columnName] != null && typeof coerced[columnName] !== "string") {
                coerced[columnName] = String(coerced[columnName]);
            }
        }
        return coerced;
    }

    const response = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
        prompt: `You are generating seed data for the SQLite table "${tableName}". The table schema (inside parentheses) is: ${schema}. Map SQLite types to JSON types STRICTLY as: text→string, integer→number, real→number, numeric→number, blob→base64 string. For any column declared as text (including "id"), values MUST be strings. If a primary key "id" is text, use UUID-like strings. Respect NOT NULL and UNIQUE constraints; ensure unique values where required. Return ONLY a valid JSON array with exactly 10 objects. No prose, no comments, no code fences, no wrapping quotes—respond with the JSON array only.`,
        // Increase output limit so the full array can be returned
        max_tokens: 4000,
        temperature: 0.2,
        stream: false,
    });
    let data: unknown;
    try {
        data = JSON.parse(response.response);
    } catch {
        data = extractJsonArrayFromText(response.response);
    }
    if (Array.isArray(data)) {
        const columnTypes = parseColumnTypes(schema);
        const coercedData = (data as any[]).map((row) => coerceRowTypes(row, columnTypes));

        // Determine NOT NULL columns by inspecting column definitions in CREATE SQL
        function escapeRegex(s: string) {
            return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        function isNotNull(col: string): boolean {
            const colEsc = escapeRegex(col);
            const nameGroup = '(?:"' + colEsc + '"|`' + colEsc + '`|\\[' + colEsc + '\\]|' + colEsc + ')';
            const pattern = new RegExp('(^|[,(])\\s*' + nameGroup + '\\s+[^,)*\\n]*\\bnot\\s+null\\b', 'i');
            return pattern.test(table.sql);
        }

        // Helpers to fabricate values for missing NOT NULL columns
        function randomUuid() {
            try { return (globalThis as any).crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`; } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
        }
        function defaultForColumn(col: string): any {
            // Prefer FK option if this is a reference column
            if (fkOptions[col]?.length) {
                return fkOptions[col][Math.floor(Math.random() * fkOptions[col].length)];
            }
            const t = (columnTypes[col] || "text").toLowerCase();
            if (col === "id" && t.includes("text")) return randomUuid();
            if (t.includes("text")) return `${col} ${Math.random().toString(36).slice(2, 8)}`;
            if (t.includes("integer") || t.includes("real") || t.includes("numeric")) return 0;
            if (t.includes("blob")) return "";
            return "";
        }

        // Post-validate, backfill NOT NULLs, and fix FK values
        function pickRandom<T>(arr: T[]): T | undefined {
            return arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;
        }
        const fixedData = coercedData.map((row) => {
            const next: any = { ...row };
            // Ensure NOT NULL columns have values
            for (const col of Object.keys(columnTypes)) {
                if (isNotNull(col)) {
                    const v = next[col];
                    const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
                    if (empty) next[col] = defaultForColumn(col);
                }
            }
            for (const { column } of refs) {
                const options = fkOptions[column] || [];
                if (options.length === 0) continue;
                const current = next[column];
                const isValid = options.includes(String(current));
                if (!isValid) {
                    const replacement = pickRandom(options);
                    if (replacement !== undefined) next[column] = replacement;
                }
            }
            return next;
        });

        await adb.deleteFrom(tableName as any).execute();
        await adb.insertInto(tableName as any).values(fixedData).execute();
    }
    return data;
}

export async function insertRow(tableName: string, row: Record<string, string>) {
    const adb: any = db;
    const masterRows = await adb.selectFrom("sqlite_master").selectAll().execute();
    const table = masterRows.find((row: any) => row.name === tableName);
    if (!table) {
        throw new Error(`Table ${tableName} not found`);
    }
    await adb.insertInto(tableName as any).values(row).execute();
}   

export async function deleteRow(tableName: string, row: Record<string, string>) {
    const adb: any = db;
    const masterRows = await adb.selectFrom("sqlite_master").selectAll().execute();
    const table = masterRows.find((row: any) => row.name === tableName);
    if (!table) {
        throw new Error(`Table ${tableName} not found`);
    }
    await adb.deleteFrom(tableName as any).where("id", "=", row.id).execute();
}   

export async function updateRow(tableName: string, row: Record<string, string>) {
    const adb: any = db;
    const masterRows = await adb.selectFrom("sqlite_master").selectAll().execute();
    const table = masterRows.find((row: any) => row.name === tableName);
    if (!table) {
        throw new Error(`Table ${tableName} not found`);
    }
    await adb.updateTable(tableName as any).set(row).where("id", "=", row.id).execute();
}   

export async function listRefOptions(tableName: string, columnName: string) {
    const adb: any = db;
    const masterRows = await adb.selectFrom("sqlite_master").selectAll().execute();
    const table = masterRows.find((row: any) => row.name === tableName);
    if (!table) throw new Error(`Table ${tableName} not found`);

    // Use the shared extractor to discover references
    const { extractColumnsFromCreate } = await import("../utils/schema");
    const schema = extractColumnsFromCreate(table.sql || "");
    const col = schema.find((c: any) => c.name === columnName);
    const ref = col?.references;
    if (!ref?.table) return [];

    // If no specific target column is given, default to "id"
    const targetColumn = ref.column || "id";
    try {
        const rows = await adb
            .selectFrom(ref.table)
            .select([targetColumn])
            .execute();
        // Normalize to string values for simplicity
        return rows.map((r: any) => String(r[targetColumn]));
    } catch {
        return [];
    }
}