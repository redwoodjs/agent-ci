#!/bin/bash

# This script creates and uploads test data to R2 to test subject hierarchy.
# It creates two related GitHub issues: a parent feature request and a child bug report.

set -e # Exit immediately if a command exits with a non-zero status.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load environment from .dev.vars
if [ -f "$PROJECT_ROOT/.dev.vars" ]; then
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.dev.vars" | grep '=')
  set +a
fi

echo "================================================="
echo "Creating Test Data for Subject Hierarchy"
echo "================================================="
echo "Environment: $MACHINEN_ENV"
echo ""

# Define Parent Issue (Feature Request)
PARENT_ISSUE_ID="github/test-data/issues/1.json"
PARENT_ISSUE_TITLE="Feature: User Profile Page"
PARENT_ISSUE_BODY="Implement a new user profile page that displays user information and activity."

# Define Child Issue (Bug Report)
CHILD_ISSUE_ID="github/test-data/issues/2.json"
CHILD_ISSUE_TITLE="Bug: Profile picture not loading on User Profile Page"
CHILD_ISSUE_BODY="The profile picture on the new user profile page is broken. It shows a 404 error."

echo "Parent Issue Title: '$PARENT_ISSUE_TITLE'"
echo "Child Issue Title:  '$CHILD_ISSUE_TITLE'"
echo ""

# Create JSON content
PARENT_JSON=$(cat <<EOF
{
  "github_id": 1,
  "number": 1,
  "state": "open",
  "author": "test-user",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "updated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "title": "$PARENT_ISSUE_TITLE",
  "body": "$PARENT_ISSUE_BODY",
  "url": "https://github.com/test-data/test-repo/issues/1"
}
EOF
)

CHILD_JSON=$(cat <<EOF
{
  "github_id": 2,
  "number": 2,
  "state": "open",
  "author": "test-user",
  "created_at": "$(date -u -v+1M +"%Y-%m-%dT%H:%M:%SZ")",
  "updated_at": "$(date -u -v+1M +"%Y-%m-%dT%H:%M:%SZ")",
  "title": "$CHILD_ISSUE_TITLE",
  "body": "$CHILD_ISSUE_BODY",
  "url": "https://github.com/test-data/test-repo/issues/2"
}
EOF
)

# Upload to R2
echo "Uploading parent issue to R2: $PARENT_ISSUE_ID"
echo "$PARENT_JSON" | npx wrangler r2 object put "$PARENT_ISSUE_ID" --pipe --remote

echo "Uploading child issue to R2: $CHILD_ISSUE_ID"
echo "$CHILD_JSON" | npx wrangler r2 object put "$CHILD_ISSUE_ID" --pipe --remote

echo ""
echo "================================================="
echo "Test Data Creation Complete."
echo "================================================="
echo "The two issues have been uploaded to R2 and should be indexed shortly."
echo "You can now use their titles to test the /rag/subjects endpoint."
echo ""
echo "Example query:"
echo "./scripts/query.sh subjects \"$CHILD_ISSUE_TITLE\""
echo ""
