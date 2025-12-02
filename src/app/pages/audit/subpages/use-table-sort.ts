"use client";

import { useState, useMemo } from "react";

export type SortDirection = "asc" | "desc" | null;

export type SortConfig<T> = {
  key: keyof T | null;
  direction: SortDirection;
};

export function useTableSort<T>(
  data: T[],
  defaultSort?: { key: keyof T; direction: "asc" | "desc" }
) {
  const [sortConfig, setSortConfig] = useState<SortConfig<T>>(
    defaultSort
      ? { key: defaultSort.key, direction: defaultSort.direction }
      : { key: null, direction: null }
  );

  const sortedData = useMemo(() => {
    if (!sortConfig.key || !sortConfig.direction) {
      return data;
    }

    return [...data].sort((a, b) => {
      const aValue = a[sortConfig.key!];
      const bValue = b[sortConfig.key!];

      // Handle null/undefined values
      if (aValue == null && bValue == null) return 0;
      if (aValue == null) return 1;
      if (bValue == null) return -1;

      // Handle Date objects
      if (aValue instanceof Date && bValue instanceof Date) {
        return sortConfig.direction === "asc"
          ? aValue.getTime() - bValue.getTime()
          : bValue.getTime() - aValue.getTime();
      }

      // Handle string dates
      if (
        typeof aValue === "string" &&
        typeof bValue === "string" &&
        !isNaN(Date.parse(aValue)) &&
        !isNaN(Date.parse(bValue))
      ) {
        const aDate = new Date(aValue).getTime();
        const bDate = new Date(bValue).getTime();
        return sortConfig.direction === "asc" ? aDate - bDate : bDate - aDate;
      }

      // Handle numbers
      if (typeof aValue === "number" && typeof bValue === "number") {
        return sortConfig.direction === "asc"
          ? aValue - bValue
          : bValue - aValue;
      }

      // Handle strings
      if (typeof aValue === "string" && typeof bValue === "string") {
        return sortConfig.direction === "asc"
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue);
      }

      // Fallback to string comparison
      const aStr = String(aValue);
      const bStr = String(bValue);
      return sortConfig.direction === "asc"
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });
  }, [data, sortConfig]);

  const handleSort = (key: keyof T) => {
    setSortConfig((current) => {
      if (current.key === key) {
        // Cycle through: desc -> asc -> null -> desc
        if (current.direction === "desc") {
          return { key, direction: "asc" };
        } else if (current.direction === "asc") {
          return { key: null, direction: null };
        } else {
          return { key, direction: "desc" };
        }
      } else {
        // New column, start with desc (newest first for dates)
        return { key, direction: "desc" };
      }
    });
  };

  return {
    sortedData,
    sortConfig,
    handleSort,
  };
}


