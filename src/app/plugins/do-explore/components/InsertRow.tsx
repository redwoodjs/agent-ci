"use client";

import { useState } from "react";
import { insertRow } from "../pages/functions";

export function InsertRow({ schema, tableName, columns, options }: { schema: any, tableName: string, columns: string[], options: string[] }) {
    const [formData, setFormData] = useState<Record<string, string>>({});
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData({ ...formData, [name]: value });
    };
    const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const { name, value } = e.target;
        setFormData({ ...formData, [name]: value });
    };
    const handleSubmit = async (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        await insertRow(tableName, formData);
        setFormData({})
    };

    return (
        <tr>    
            {columns.map((c) => {
                const colMeta = schema.find((s: any) => s.name === c);
                const ref = colMeta?.references;
                return (
                    <td key={c} className="px-3 py-2 align-middle whitespace-nowrap max-w-[28rem]">
                        {ref?.table ? (
                            <select className="w-full h-8 border rounded p-1" name={c} value={formData[c] || ""} onChange={handleSelectChange}>
                                <option value="">Select…</option>
                                {options.map((v: string) => (
                                    <option key={v} value={v}>{v}</option>
                                ))}
                            </select>
                        ) : (
                            <input className="w-full h-8 border rounded p-1" type="text" name={c} value={formData[c] || ""} onChange={handleInputChange} />
                        )}
                </td>
                );
            })}
            <td className="px-3 py-2 align-middle">
                <button className="btn btn-outline btn-pill" onClick={handleSubmit} type="submit">Submit</button>
            </td>
        </tr>
    );
}   