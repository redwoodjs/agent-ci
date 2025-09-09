"use client";
import { useState } from "react";
import { seedTable } from "../pages/functions";

export function SeedButton({ tableName }: { tableName: string }) {
    const [isLoading, setIsLoading] = useState(false);
    const handleClick = async () => {
        setIsLoading(true);
        await seedTable(tableName);
        setIsLoading(false);
    };
    return <button className="btn btn-cta btn-pill" onClick={handleClick} disabled={isLoading}>{isLoading ? "Seeding..." : "Seed " + tableName}</button>;
}