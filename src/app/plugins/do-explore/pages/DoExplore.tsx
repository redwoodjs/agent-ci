"use server";
import { db } from "@/db";

export async function DoExplore({ params }: { params: { table: string } }) {
  const table = params.table;
  // "/" → default binding and db key
  // "/:table" → select a table
  const selectedTable: string | undefined = table;

  // Discover tables (cast to any for sqlite_master introspection)
  const masterRows = await (db as any)
    .selectFrom("sqlite_master")
    .selectAll()
    .execute();
  const tableNames = masterRows
    .filter(
      (r: any) =>
        r.type === "table" &&
        typeof r.name === "string" &&
        !r.name.startsWith("sqlite_")
    )
    .map((r: any) => r.name as string)
    .sort((a: string, b: string) => a.localeCompare(b));

  // Counts for each table
  const tableCountsEntries = await Promise.all(
    tableNames.map(async (name: string) => {
      try {
        const res = await (db as any)
          .selectFrom(name)
          .select(({ fn }: any) => [fn.countAll().as("count")])
          .execute();
        const count = Number(res?.[0]?.count ?? 0);
        return [name, count] as const;
      } catch {
        return [name, 0] as const;
      }
    })
  );
  const tableCounts = Object.fromEntries(tableCountsEntries) as Record<
    string,
    number
  >;

  const activeTable =
    selectedTable && tableNames.includes(selectedTable)
      ? selectedTable
      : tableNames[0];

  let rows: any[] = [];
  let columns: string[] = [];
  let total = activeTable ? tableCounts[activeTable] ?? 0 : 0;
  
  if (activeTable) {
    try {
      const qb: any = (db as any).selectFrom(activeTable).selectAll();
      rows = await qb.execute();
      if (rows.length > 0) {
        columns = Object.keys(rows[0]);
      }
    } catch {
      rows = [];
    }
  }

  return (
    <div className="flex min-h-[70vh]">
      {/* Sidebar: tables and counts */}
      <aside className="w-64 shrink-0 border-r border-dotted">
        <div className="p-4">
          <img
            src="/images/sdk-logo-black.png"
            alt="RedwoodSDK logo"
            className="p-2"
          />
          <hr className="border-muted my-2" />
          <h1 className="text-lg font-semibold heading-serif">DoX</h1>
          <p className="text-xs muted">RedwoodSDK Durable Object Explorer</p>
        </div>
        <nav className="p-2 space-y-1">
          {tableNames.length === 0 ? (
            <div className="text-sm muted p-2">No tables found.</div>
          ) : (
            tableNames.map((name: string) => {
              const isActive = name === activeTable;
              return (
                <a
                  key={name}
                  href={`/dox/${name}`}
                  className={
                    "flex items-center justify-between rounded px-3 py-2 text-sm " +
                    (isActive ? "nav-active font-medium" : "hover:bg-black/5")
                  }
                >
                  <span className="truncate">{name}</span>
                  <span className="ml-2 text-xs muted">
                    {tableCounts[name] ?? 0}
                  </span>
                </a>
              );
            })
          )}
        </nav>
      </aside>

      {/* Main content: table viewer */}
      <main className="flex-1 p-4">
        {activeTable ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold">{activeTable}</h2>
                <p className="text-xs text-black/60">{total} records</p>
              </div>
            </div>

            <div className="overflow-auto border rounded">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    {columns.map((c) => (
                      <th
                        key={c}
                        className="text-left font-medium px-3 py-2 whitespace-nowrap"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => (
                    <tr key={idx} className="border-b">
                      {columns.map((col) => (
                        <td key={col} className="px-3 py-2">
                          {typeof row[col] === "object"
                            ? JSON.stringify(row[col])
                            : String(row[col] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="text-sm text-black/60">No tables available.</div>
        )}
      </main>
    </div>
  );
}
