#!/bin/bash
set -e

# Define paths
CURSOR_CONFIG_DIR="$HOME/.cursor"
HOOKS_DIR="$CURSOR_CONFIG_DIR/hooks"
HOOKS_JSON_FILE="$CURSOR_CONFIG_DIR/hooks.json"
HOOK_SCRIPT_NAME="machinen-ingest-hook.sh"
SOURCE_HOOK_SCRIPT_PATH="$(pwd)/src/app/ingestors/cursor/scripts/hook.sh"
TARGET_HOOK_SCRIPT_PATH="$HOOKS_DIR/$HOOK_SCRIPT_NAME"

# Create directories if they don't exist
mkdir -p "$HOOKS_DIR"

# Copy the hook script
cp "$SOURCE_HOOK_SCRIPT_PATH" "$TARGET_HOOK_SCRIPT_PATH"
chmod +x "$TARGET_HOOK_SCRIPT_PATH"

# Create or update hooks.json
if [ -f "$HOOKS_JSON_FILE" ]; then
  # A simple approach for now: backup and overwrite.
  # A more robust solution would merge the JSON.
  cp "$HOOKS_JSON_FILE" "$HOOKS_JSON_FILE.bak"
  echo "Backed up existing hooks.json to $HOOKS_JSON_FILE.bak"
fi

# NOTE: This will overwrite any existing hooks.
# A real implementation should merge these hooks.
cat > "$HOOKS_JSON_FILE" << EOL
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [{ "command": "./hooks/$HOOK_SCRIPT_NAME" }],
    "afterShellExecution": [{ "command": "./hooks/$HOOK_SCRIPT_NAME" }],
    "afterMCPExecution": [{ "command": "./hooks/$HOOK_SCRIPT_NAME" }],
    "afterFileEdit": [{ "command": "./hooks/$HOOK_SCRIPT_NAME" }],
    "beforeReadFile": [{ "command": "./hooks/$HOOK_SCRIPT_NAME" }],
    "beforeSubmitPrompt": [{ "command": "./hooks/$HOOK_SCRIPT_NAME" }],
    "afterAgentResponse": [{ "command": "./hooks/$HOOK_SCRIPT_NAME" }],
    "stop": [{ "command": "./hooks/$HOOK_SCRIPT_NAME" }]
  }
}
EOL

echo "Cursor hooks for Machinen ingest have been set up."
echo "Please restart Cursor to apply the changes."
