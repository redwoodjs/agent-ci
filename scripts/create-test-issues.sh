#!/bin/bash

# This script uses the gh CLI to create test issues in the redwoodjs/machinen repo.
# These issues will serve as test data for the subjects feature.
#
# Make sure you are logged in with the gh CLI: `gh auth login`
# And have write access to the redwoodjs/machinen repository.

set -e

REPO="redwoodjs/machinen"

echo "================================================="
echo "Creating Test Issues in GitHub Repo: $REPO"
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

# Create Parent Issue
echo "Creating parent issue..."
gh issue create --repo "$REPO" --title "$PARENT_ISSUE_TITLE" --body "$PARENT_ISSUE_BODY"

# Create Child Issue
echo "Creating child issue..."
gh issue create --repo "$REPO" --title "$CHILD_ISSUE_TITLE" --body "$CHILD_ISSUE_BODY"

echo ""
echo "================================================="
echo "Test Issue Creation Complete."
echo "================================================="
echo "The two issues have been created in the '$REPO' repository."
echo "They should be ingested and indexed shortly."
echo "You can now use their titles to test the /rag/subjects endpoint."
echo ""
echo "Example query:"
echo "./scripts/query.sh subjects \"$CHILD_ISSUE_TITLE\""
echo ""
