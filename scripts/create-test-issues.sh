#!/bin/bash

# This script uses the gh CLI to idempotently create test issues in the
# redwoodjs/machinen repo. It checks if issues with the exact titles
# already exist before creating them.
#
# Make sure you are logged in with the gh CLI: `gh auth login`
# And have write access to the redwoodjs/machinen repository.

set -e

REPO="redwoodjs/machinen"

echo "================================================="
echo "Ensuring Test Issues Exist in GitHub Repo: $REPO"
echo "================================================="

# Define Parent Issue (Feature Request)
PARENT_ISSUE_TITLE="[Test Subject] Feature: User Profile Page"
PARENT_ISSUE_BODY=$(cat <<'EOF'
This is a test issue to represent a parent feature request for the knowledge synthesis engine.

It will serve as the root subject for related bugs and tasks.
EOF
)

# Define Child Issue (Bug Report)
CHILD_ISSUE_TITLE="[Test Subject] Bug: Profile picture not loading"
CHILD_ISSUE_BODY=$(cat <<'EOF'
This is a test issue to represent a child bug report related to the "User Profile Page" feature.

When the hierarchy logic is implemented, this should be linked as a child of the parent feature issue.
EOF
)

# --- Function to check and create an issue ---
ensure_issue() {
  local title="$1"
  local body="$2"
  
  echo "Checking for issue: \"$title\"..."
  
  # Search for the issue by its exact title.
  # The search query must be precise.
  # We use jq to count the number of results.
  local issue_exists=$(gh issue list --repo "$REPO" --search "\"$title\" in:title" --json number | jq 'length')
  
  if [ "$issue_exists" -eq 0 ]; then
    echo "Issue not found. Creating it..."
    gh issue create --repo "$REPO" --title "$title" --body "$body"
  else
    echo "Issue already exists. Skipping."
  fi
}

# Ensure both issues exist
ensure_issue "$PARENT_ISSUE_TITLE" "$PARENT_ISSUE_BODY"
ensure_issue "$CHILD_ISSUE_TITLE" "$CHILD_ISSUE_BODY"


echo ""
echo "================================================="
echo "Test Issue Setup Complete."
echo "================================================="
echo "The test issues are now present in the '$REPO' repository."
echo "They should be ingested and indexed shortly (if not already)."
echo ""
echo "Example query to test:"
echo "./scripts/query.sh subjects \"$CHILD_ISSUE_TITLE\""
echo ""
