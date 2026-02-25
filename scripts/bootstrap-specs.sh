#!/bin/sh

# Machinen Speccing Engine Bootstrap
# Detects the project namespace and initializes the speccing protocol.

set -e

# Configuration
DEFAULT_WORKER_URL="https://machinen.redwoodjs.workers.dev"
WORKER_URL="${MACHINEN_ENGINE_URL:-$DEFAULT_WORKER_URL}"

if [ -z "$API_KEY" ]; then
  echo "Warning: API_KEY environment variable not set. API calls will fail."
fi

# 1. Detect Repository from Git
# Extracts "owner/repo" from origin remote
REPOSITORY=$(git remote -v 2>/dev/null | grep 'origin.*(fetch)' | head -n 1 | sed -E 's/.*github.com[:\/](.*)\.git.*/\1/' | sed 's/.*github.com[:\/]//')

if [ -z "$REPOSITORY" ]; then
  # Fallback: Use directory name
  REPOSITORY=$(basename "$(pwd)")
  echo "Notice: Could not detect repository from git, using directory name: $REPOSITORY"
else
  echo "Detected Project Repository: $REPOSITORY"
fi

if [ -n "$NAMESPACE_PREFIX" ]; then
  echo "Using Namespace Prefix: $NAMESPACE_PREFIX"
fi

# 2. Check/Inject .agent/rules/machinen.md (The Protocol & Standard)
if [ ! -f ".agent/rules/machinen.md" ]; then
  echo "Initializing .agent/rules/machinen.md..."
  mkdir -p .agent/rules
  cat <<EOF > .agent/rules/machinen.md
# Machinen Speccing Protocol

You are an expert technical writer and architect. Your role is to reassemble the historical development narrative provided by the Machinen Speccing Engine into an authoritative technical specification.

## 1. Autonomous Specification Generation
The most robust way to generate a specification is using the autonomous driver:
\`\`\`bash
./scripts/mchn-spec.sh "Refactor the authentication flow"
\`\`\`
This command will:
1. Discover the relevant Subject ID from your prompt.
2. Initialize a stateful speccing session on the Machinen backend.
3. Iteratively revise the specification draft in \`docs/specs/\` as it replays the historical narrative.

## 2. Manual/Advanced Discovery
If you need to find a specific Subject ID manually, run:
\`\`\`bash
curl -X POST "$WORKER_URL/api/subjects/search" \\
  -H "Authorization: Bearer \$API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "query": "Summary of recent work", "context": { "repository": "$REPOSITORY", "namespacePrefix": "$NAMESPACE_PREFIX" } }'
\`\`\`

## 3. Formatting Standard
- **Location**: Your output is a **single** markdown file located in \`docs/specs/\`.
- **Iteration**: This file is **iteratively refined** by the server-side Actor.
- **Consensus Only**: Focus strictly on final consensus, settled decisions, and the "Definition of Done".
- **Source Citation**: Every design decision must be cited using the preview URL: \`$WORKER_URL/audit/ingestion/file/<R2_KEY>\`.

## 4. Mandatory Spec Structure
- **2000ft View Narrative**: High-level architectural narrative.
- **Database Changes**: Schema changes and their rationale.
- **Behavior Spec**: Ground truth behaviors (GIVEN/WHEN/THEN).
- **Implementation Detail**: Breakdown of code changes (\`[NEW]\`, \`[MODIFY]\`, \`[DELETE]\`).
- **Directory & File Structure**: Tree view of files.
- **Types & Data Structures**: Snippets of types.
- **Invariants & Constraints**: Rules for the system.
- **System Flow (Snapshot Diff)**: Previous -> New flow delta.
- **Suggested Verification**: Commands/URLs for manual validation.
- **Tasks**: Granular checklist.
EOF
  echo "✅ .agent/rules/machinen.md created."
else
  echo "✓ .agent/rules/machinen.md already exists."
fi

# 3. Cleanup Legacy Hidden Directories
if [ -d ".machinen" ]; then
  echo "Cleaning up legacy .machinen directory..."
  rm -rf .machinen
fi

# 4. Final Instructions
echo ""
echo "----------------------------------------------------------------"
echo "Machinen Speccing Engine Initialized"
echo "----------------------------------------------------------------"
echo "Repository: $REPOSITORY"
echo "Prefix:     $NAMESPACE_PREFIX"
echo "Worker:     $WORKER_URL"
echo ""
echo "Autonomous Generation Command:"
echo "./scripts/mchn-spec.sh \"Summary of recent work\""
echo ""
echo "Manual Discovery Command:"
echo "curl -X POST \"$WORKER_URL/api/subjects/search\" \\"
echo "  -H \"Authorization: Bearer \$API_KEY\" \\"
echo "  -H \"Content-Type: application/json\" \\"
echo "  -d '{\"query\": \"Summary of recent work\", \"context\": {\"repository\": \"$REPOSITORY\", \"namespacePrefix\": \"$NAMESPACE_PREFIX\"}}'"
echo "----------------------------------------------------------------"
