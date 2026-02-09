#!/bin/sh

# Machinen Speccing Engine Bootstrap
# Detects the project namespace and initializes the speccing protocol.

set -e

# Configuration
DEFAULT_WORKER_URL="https://machinen-engine.justin.workers.dev"
WORKER_URL="${MACHINEN_ENGINE_URL:-$DEFAULT_WORKER_URL}"

if [ -z "$API_KEY" ]; then
  echo "Warning: API_KEY environment variable not set. API calls will fail."
fi

# 1. Detect Namespace from Git
# Extracts "owner/repo" from origin remote
NAMESPACE=$(git remote -v 2>/dev/null | grep 'origin.*(fetch)' | head -n 1 | sed -E 's/.*github.com[:\/](.*)\.git.*/\1/' | sed 's/.*github.com[:\/]//')

if [ -z "$NAMESPACE" ]; then
  # Fallback: Use directory name
  NAMESPACE=$(basename "$(pwd)")
  echo "Notice: Could not detect namespace from git, using directory name: $NAMESPACE"
else
  echo "Detected Project Namespace: $NAMESPACE"
fi

# 2. Check/Inject AGENTS.md (The Protocol)
if [ ! -f "AGENTS.md" ]; then
  echo "Initializing AGENTS.md..."
  cat <<EOF > AGENTS.md
# Machinen Speccing Protocol

This project use the Machinen Speccing Engine for autonomous development.

## Core Rules
1. **The SPEC is the Source of Truth**: All architectural decisions MUST be reflected in the specification during the speccing replay.
2. **Reconstructed Narrative**: We follow the chronological replay of moments from the Knowledge Graph to recover design rationale.
3. **Pure Curl**: We interact with the engine via \`curl\` and follow its self-instructing narrative loop.

## Discovery
To discover a subject (feature/initiative) to spec:
\`\`\`bash
curl -X POST "$WORKER_URL/api/subjects/search" \\
  -H "Authorization: Bearer \$API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "Recent architectural changes", "namespace": "$NAMESPACE"}'
\`\`\`
EOF
  echo "✅ AGENTS.md created."
else
  echo "✓ AGENTS.md already exists."
fi

# 3. Inject Native IDE Rules (.cursorrules / .windsurf)
# Only if they don't exist, to avoid overwriting user preferences
for rule_file in .cursorrules .windsurfrules; do
  if [ ! -f "$rule_file" ]; then
    echo "Initializing $rule_file..."
    cat <<EOF > "$rule_file"
# Machinen Speccing Protocol
Refer to AGENTS.md for core rules.
Always prioritize the narrative replay provided by the Speccing Engine API.
EOF
    echo "✅ $rule_file created."
  fi
done

# 4. Final Instructions
echo ""
echo "----------------------------------------------------------------"
echo "Machinen Speccing Engine Initialized"
echo "----------------------------------------------------------------"
echo "Namespace:  $NAMESPACE"
echo "Worker:     $WORKER_URL"
echo ""
echo "Discovery Command:"
echo "curl -X POST \"$WORKER_URL/api/subjects/search\" \\"
echo "  -H \"Authorization: Bearer \$API_KEY\" \\"
echo "  -H \"Content-Type: application/json\" \\"
echo "  -d '{\"query\": \"Summary of recent work\", \"namespace\": \"$NAMESPACE\"}'"
echo "----------------------------------------------------------------"
