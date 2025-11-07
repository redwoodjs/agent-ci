#!/bin/bash

# Setup rclone for Cloudflare R2
# Usage: ./scripts/setup-r2-rclone.sh

set -e

echo "Setting up rclone for Cloudflare R2"
echo ""

# Check if rclone is installed
if ! command -v rclone &> /dev/null; then
  echo "rclone is not installed."
  echo ""
  echo "Install it with:"
  echo "  brew install rclone  # macOS"
  echo "  or visit: https://rclone.org/install/"
  exit 1
fi

# Prompt for credentials
read -p "R2 Account ID: " R2_ACCOUNT_ID
read -p "R2 Access Key ID: " R2_ACCESS_KEY_ID
read -sp "R2 Secret Access Key: " R2_SECRET_ACCESS_KEY
echo ""

# Configure rclone interactively
echo ""
echo "Configuring rclone remote 'r2'..."
echo "When prompted, use these values:"
echo "  Type: s3"
echo "  Provider: Cloudflare"
echo "  Access Key ID: ${R2_ACCESS_KEY_ID}"
echo "  Secret Access Key: [hidden]"
echo "  Region: auto"
echo "  Endpoint: https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
echo ""

# Use rclone config to set up the remote
rclone config create r2 s3 \
  provider=Cloudflare \
  access_key_id="${R2_ACCESS_KEY_ID}" \
  secret_access_key="${R2_SECRET_ACCESS_KEY}" \
  region=auto \
  endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

echo ""
echo "rclone remote 'r2' configured successfully!"
echo ""
echo "To sync a bucket, use:"
echo "  ./scripts/sync-r2-bucket.sh [bucket-name] [local-path] [prefix]"
echo ""
echo "Or use rclone directly:"
echo "  rclone sync r2:machinen ./local-path"
echo "  rclone sync r2:machinen/github ./local-path/github"

