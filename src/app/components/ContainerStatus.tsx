"use client";

import { useState, useEffect } from "react";
import { Button } from "@/app/components/ui/button";
import {
  startContainerById,
  getInstanceStatus,
} from "@/app/pages/session/functions";

interface ContainerStatusProps {
  containerId: string;
  initialStatus?: {
    running: boolean;
    timestamp: string;
  };
}

export function ContainerStatus({
  containerId,
  initialStatus,
}: ContainerStatusProps) {
  const [status, setStatus] = useState(initialStatus);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  const checkStatus = async () => {
    setLoading(true);
    try {
      const newStatus = await getInstanceStatus(containerId);
      setStatus(newStatus);
    } catch (error) {
      console.error("Failed to check container status:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async () => {
    setStarting(true);
    try {
      const result = await startContainerById(containerId);
      if (result.started) {
        setStatus({
          running: true,
          timestamp: result.timestamp,
        });
      }
    } catch (error) {
      console.error("Failed to start container:", error);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    const interval = setInterval(checkStatus, 2000);
    return () => clearInterval(interval);
  }, [containerId]);

  return (
    <div className="flex items-center gap-4 p-4 border rounded-lg">
      <div className="flex-1">
        <div className="font-medium">Container: {containerId}</div>
        <div className="text-sm text-gray-600">
          Status:{" "}
          {status?.running ? (
            <span className="text-green-600 font-medium">Running</span>
          ) : (
            <span className="text-red-600 font-medium">Stopped</span>
          )}
        </div>
        {status?.timestamp && (
          <div className="text-xs text-gray-400">
            Last checked: {new Date(status.timestamp).toLocaleTimeString()}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button
          onClick={checkStatus}
          disabled={loading}
          variant="outline"
          size="sm"
        >
          {loading ? "Checking..." : "Refresh"}
        </Button>

        {!status?.running && (
          <Button onClick={handleStart} disabled={starting} size="sm">
            {starting ? "Starting..." : "Start"}
          </Button>
        )}
      </div>
    </div>
  );
}
