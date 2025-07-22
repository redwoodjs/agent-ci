"use client";

import { useState, useEffect } from "react";

export function useContainers() {
  const [containers, setContainers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchContainers = async () => {
    try {
      setLoading(true);
      // We need to create an API endpoint to get containers from the client side
      const response = await fetch("/api/containers");
      if (!response.ok) {
        throw new Error("Failed to fetch containers");
      }
      const data = await response.json();
      setContainers(data.containers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setContainers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContainers();
  }, []);

  return {
    containers,
    loading,
    error,
    refetch: fetchContainers,
  };
}