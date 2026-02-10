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

# 2. Check/Inject AGENTS.md (The Protocol)
if [ ! -f "AGENTS.md" ]; then
  echo "Initializing AGENTS.md..."
  cat <<EOF > AGENTS.md
# Machinen Speccing Protocol

You are an expert technical writer and architect. Your task is to reconstruct a high-fidelity technical specification by replaying the development narrative of a specific "Subject" (feature/initiative).

## The Protocol
1. **Discovery**: Identify the Subject you want to spec.
   \`\`\`bash
   curl -X POST "$WORKER_URL/api/subjects/search" \\
     -H "Authorization: Bearer \$API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{
       "query": "Recent work",
       "context": {
         "repository": "$REPOSITORY",
         "namespacePrefix": "$NAMESPACE_PREFIX"
       }
     }'
   \`\`\`
2. **Bootstrap**: Initialize the speccing session for a Subject ID.
   \`\`\`bash
   curl -X POST "$WORKER_URL/api/speccing/start?subjectId=<ID>" \\
     -H "Authorization: Bearer \$API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{
       "context": {
         "repository": "$REPOSITORY",
         "namespacePrefix": "$NAMESPACE_PREFIX"
       }
     }'
   \`\`\`
3. **The Turn**: The response will contain a \`moment\` and \`evidence\`.
4. **The Action**: Integrate the evidence into the specification at \`docs/specs/<subject>.md\`.
5. **The Loop**: Always follow the \`instruction\` field in the JSON response. It will provide the next \`curl\` command to execute.

## Mandatory Spec Structure
Your output must follow this structure:
- **2000ft View Narrative**: High-level architectural narrative.
- **Database Changes**: Schema changes and their rationale.
- **Behavior Spec**: Ground truth behaviors (GIVEN/WHEN/THEN).
- **Implementation Detail**:
    - **Pipes**: Data flow steps.
    - **Breakdown**: Code changes (\`[NEW]\`, \`[MODIFY]\`, \`[DELETE]\`).
- **Directory & File Structure**: Tree view of files.
- **Types & Data Structures**: Snippets of types.
- **Invariants & Constraints**: Rules for the system.
- **System Flow (Snapshot Diff)**: Previous -> New flow delta.
- **Suggested Verification**: Commands/URLs for manual validation.
- **Tasks**: Granular checklist.
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
echo "Repository: $REPOSITORY"
echo "Prefix:     $NAMESPACE_PREFIX"
echo "Worker:     $WORKER_URL"
echo ""
echo "Discovery Command:"
echo "curl -X POST \"$WORKER_URL/api/subjects/search\" \\"
echo "  -H \"Authorization: Bearer \$API_KEY\" \\"
echo "  -H \"Content-Type: application/json\" \\"
echo "  -d '{\"query\": \"Summary of recent work\", \"context\": {\"repository\": \"$REPOSITORY\", \"namespacePrefix\": \"$NAMESPACE_PREFIX\"}}'"
echo "----------------------------------------------------------------"
