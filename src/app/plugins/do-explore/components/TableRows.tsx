"use client";
import { deleteRow, updateRow } from "../pages/functions";

export function TableRows({ tableName, rows, columns }: { tableName: string, rows: any[], columns: string[] }) {

    if (rows.length === 0) {
        return (
            <tr>
                <td className="px-3 py-4 text-black/60" colSpan={Math.max(1, columns.length)}>No records.</td>
            </tr>
        );
    }
    return rows.map((row, idx) => (
        <tr key={idx} className="border-b border-dotted odd:bg-transparent even:bg-[var(--accent-surface)]">
            {columns.map((c) => (
                <td key={c} className="px-3 py-2 align-middle whitespace-nowrap max-w-[28rem]">
                    <input className="w-full h-8 border rounded p-1" type="text" name={c} value={String(row[c])} onChange={(e) => updateRow(tableName, { ...row, [c]: e.target.value })} />
                </td>
            ))}
            <td className="px-3 py-2 align-middle">
                <div className="flex gap-2">
                    <button className="btn btn-outline btn-pill" onClick={() => deleteRow(tableName, row)} type="submit">Delete</button>
                </div>
            </td>
        </tr>
    ));
}