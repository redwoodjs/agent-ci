#!/usr/bin/env bash
#
# Boot up multiple devcontainer agents and open Antigravity windows for each.
#
# Usage:
#   ./scripts/agents-up.sh        # Start all agents (1-5)
#   ./scripts/agents-up.sh 3      # Start agents 1-3
#   ./scripts/agents-up.sh 2 4    # Start agents 2-4
#

set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Find the antigravity CLI
if command -v antigravity &> /dev/null; then
  AGY="antigravity"
elif [ -x "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity" ]; then
  AGY="/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity"
else
  echo "❌ Could not find the 'antigravity' CLI."
  echo "   Install it via: Antigravity → Command Palette → 'Shell Command: Install antigravity command'"
  exit 1
fi

# Parse arguments
if [ $# -eq 0 ]; then
  START=1
  END=5
elif [ $# -eq 1 ]; then
  START=1
  END=$1
elif [ $# -eq 2 ]; then
  START=$1
  END=$2
else
  echo "Usage: $0 [count] or $0 [start] [end]"
  exit 1
fi

# Check for devcontainer CLI
if ! command -v devcontainer &> /dev/null; then
  echo "⚠️  'devcontainer' CLI not found. Installing..."
  npm install -g @devcontainers/cli
fi

echo "🚀 Booting agents ${START}-${END} from ${WORKSPACE_DIR}"
echo ""

for i in $(seq "$START" "$END"); do
  CONFIG="${WORKSPACE_DIR}/.devcontainer/agent-${i}/devcontainer.json"

  if [ ! -f "$CONFIG" ]; then
    echo "⚠️  Skipping agent-${i}: no config at ${CONFIG}"
    continue
  fi

  echo "📦 Starting agent-${i}..."
  devcontainer up \
    --workspace-folder "$WORKSPACE_DIR" \
    --config "$CONFIG" &
done

# Wait for all background devcontainer up commands to finish
echo ""
echo "⏳ Waiting for all containers to start..."
wait
echo ""

# Open Antigravity windows for each
for i in $(seq "$START" "$END"); do
  CONFIG="${WORKSPACE_DIR}/.devcontainer/agent-${i}/devcontainer.json"

  if [ ! -f "$CONFIG" ]; then
    continue
  fi

  echo "🖥️  Opening Antigravity for agent-${i}..."
  # Hex-encode the workspace folder path for the devcontainer URI
  HEX_PATH=$(printf '%s' "$WORKSPACE_DIR" | xxd -p | tr -d '\n')
  CONFIG_REL=".devcontainer/agent-${i}/devcontainer.json"
  HEX_CONFIG=$(printf '%s' "$CONFIG_REL" | xxd -p | tr -d '\n')

  "$AGY" --new-window --folder-uri "vscode-remote://dev-container+${HEX_PATH}+${HEX_CONFIG}/workspaces/$(basename "$WORKSPACE_DIR")"
done

echo ""
echo "✅ All agents are up!"
