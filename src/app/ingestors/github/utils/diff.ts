export interface EntityDiff {
  timestamp: string;
  timestampForFilename: string;
  changes: Record<string, { from: unknown; to: unknown }>;
}

export function generateDiff<T extends Record<string, unknown> | { [key: string]: unknown }>(
  oldEntity: T | null,
  newEntity: T
): EntityDiff | null {
  if (!oldEntity) {
    return null;
  }

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const oldEntityObj = oldEntity as Record<string, unknown>;
  const newEntityObj = newEntity as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(oldEntityObj), ...Object.keys(newEntityObj)]);

  for (const key of allKeys) {
    const oldValue = oldEntityObj[key];
    const newValue = newEntityObj[key];

    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes[key] = { from: oldValue, to: newValue };
    }
  }

  if (Object.keys(changes).length === 0) {
    return null;
  }

  const now = new Date();
  const isoString = now.toISOString();
  const timestampForFilename = isoString.replace(/[:.]/g, "-");
  
  return {
    timestamp: isoString,
    timestampForFilename,
    changes,
  };
}

