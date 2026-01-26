# Recipe: Moment Graph SQLite Investigation

## Problem
How to find specific moments or verify linkages across multiple Durable Object SQLite shards when the namespace mapping is unknown or fragmented (e.g., during simulation runs).

## Context
Moments are stored in shard-specific SQLite files under `.wrangler/state/v3/do/machinen-MomentGraphDO/`. The filename is a SHA-256 hash of the `namespace:base_name`.

## Solution

### 1. Calculate a Shard Hash for a Namespace
Use Node's `crypto` to match a namespace (e.g., from `simulation_runs`) to a `.sqlite` file.
```bash
node -e 'const crypto = require("crypto"); const name = "local-namespace:moment-graph-v2"; console.log(crypto.createHash("sha256").update(name).digest("hex"))'
```

### 2. Search All Shards for a Moment ID
If the namespace is unknown, brute-force search across all `.sqlite` files.
```bash
for db in .wrangler/state/v3/do/machinen-MomentGraphDO/*.sqlite; do
  res=$(sqlite3 "$db" "SELECT id FROM moments WHERE id = 'YOUR-UUID-HERE';" 2>/dev/null)
  if [ ! -z "$res" ]; then
    echo "Found in $db"
  fi
done
```

### 3. Verify Recursive Linkage (Upward)
Find parents and grand-parents for a specific moment.
```bash
sqlite3 "PATH_TO_DB.sqlite" "
WITH RECURSIVE ancestors(id, parent_id, depth) AS (
  SELECT id, parent_id, 0 FROM moments WHERE id = 'STARTING_UUID'
  UNION ALL
  SELECT m.id, m.parent_id, a.depth + 1
  FROM moments m JOIN ancestors a ON m.id = a.parent_id
  WHERE a.depth < 10
)
SELECT * FROM ancestors;
"
```

### 4. Brute-Force Map All Namespaces to Shards
Cross-reference `simulation_run_participating_namespaces` with active shards.
```bash
sqlite3 ".wrangler/state/v3/do/machinen-EngineSimulationStateDO/f15.sqlite" "SELECT DISTINCT namespace FROM simulation_run_participating_namespaces;" | \
xargs -I {} node -e 'const crypto = require("crypto"); const name = "{}:moment-graph-v2"; console.log(`${name} -> ${crypto.createHash("sha256").update(name).digest("hex")}`);'
```
