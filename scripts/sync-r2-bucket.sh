#!/bin/bash

# Sync R2 bucket to local directory using rclone
# Usage: ./scripts/sync-r2-bucket.sh [bucket-name] [local-path] [prefix]

set -e

BUCKET_NAME=${1:-"machinen"}
LOCAL_PATH=${2:-"./r2-backup/${BUCKET_NAME}"}
PREFIX=${3:-""}

# Check if rclone is installed
if ! command -v rclone &> /dev/null; then
  echo "Error: rclone is not installed"
  echo ""
  echo "Install it with:"
  echo "  brew install rclone  # macOS"
  echo "  or visit: https://rclone.org/install/"
  exit 1
fi

# Check if r2 remote is configured
if ! rclone listremotes | grep -q "^r2:"; then
  echo "Error: rclone remote 'r2' is not configured"
  echo ""
  echo "Run the setup script first:"
  echo "  ./scripts/setup-r2-rclone.sh"
  exit 1
fi

echo "Syncing R2 bucket '${BUCKET_NAME}' to '${LOCAL_PATH}'"
if [ -n "$PREFIX" ]; then
  echo "Prefix filter: ${PREFIX}"
fi
echo ""

# Create local directory if it doesn't exist
mkdir -p "$LOCAL_PATH"

# Build the remote path
if [ -n "$PREFIX" ]; then
  REMOTE_PATH="r2:${BUCKET_NAME}/${PREFIX}"
else
  REMOTE_PATH="r2:${BUCKET_NAME}"
fi

# Use rclone sync (similar to rsync)
rclone sync "$REMOTE_PATH" "$LOCAL_PATH" --progress

echo ""
echo "Sync complete!"

