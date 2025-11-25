#!/bin/bash
set -e

# Define paths
CURSOR_CONFIG_DIR="$HOME/.cursor"
HOOKS_DIR="$CURSOR_CONFIG_DIR/hooks"
HOOKS_JSON_FILE="$CURSOR_CONFIG_DIR/hooks.json"
HOOK_SCRIPT_NAME="machinen-ingest-hook.sh"
SOURCE_HOOK_SCRIPT_PATH="$(pwd)/src/app/ingestors/cursor/scripts/hook.sh"
TARGET_HOOK_SCRIPT_PATH="$HOOKS_DIR/$HOOK_SCRIPT_NAME"

MCP_SERVER_NAME="machinen-mcp-server.mjs"
MCP_SERVER_TARGET_PATH="$HOOKS_DIR/$MCP_SERVER_NAME"

# MCP config paths
GLOBAL_MCP_CONFIG="$CURSOR_CONFIG_DIR/mcp.json"

# Create directories if they don't exist
mkdir -p "$HOOKS_DIR"
mkdir -p "$(pwd)/dist/cursor"

# Build the MCP server
echo "Building MCP server..."
npm run build:mcp-server

# Copy the hook script
cp "$SOURCE_HOOK_SCRIPT_PATH" "$TARGET_HOOK_SCRIPT_PATH"
chmod +x "$TARGET_HOOK_SCRIPT_PATH"

# Copy the bundled MCP server
cp "$(pwd)/dist/cursor/mcp-server.mjs" "$MCP_SERVER_TARGET_PATH"
chmod +x "$MCP_SERVER_TARGET_PATH"

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

# Create or update mcp.json (global/user-wide)
if [ -f "$GLOBAL_MCP_CONFIG" ]; then
  cp "$GLOBAL_MCP_CONFIG" "$GLOBAL_MCP_CONFIG.bak"
  echo "Backed up existing mcp.json to $GLOBAL_MCP_CONFIG.bak"
  
  # Merge machinen server into existing mcp.json
  node -e "
    const fs = require('fs');
    const configPath = '$GLOBAL_MCP_CONFIG';
    let config = {};
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(content);
    } catch (e) {
      console.error('Error reading mcp.json:', e.message);
      process.exit(1);
    }
    
    if (!config.mcpServers) {
      config.mcpServers = {};
    }
    
    config.mcpServers.machinen = {
      type: 'stdio',
      command: 'node',
      args: ['\${userHome}/.cursor/hooks/machinen-mcp-server.mjs'],
      env: {
        MACHINEN_API_KEY: '\${env:MACHINEN_API_KEY}',
        MACHINEN_API_URL: 'https://machinen.redwoodjs.workers.dev'
      }
    };
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log('✓ Updated MCP configuration at', configPath);
  "
else
  # Create new mcp.json
  cat > "$GLOBAL_MCP_CONFIG" << 'EOL'
{
  "mcpServers": {
    "machinen": {
      "type": "stdio",
      "command": "node",
      "args": ["${userHome}/.cursor/hooks/machinen-mcp-server.mjs"],
      "env": {
        "MACHINEN_API_KEY": "${env:MACHINEN_API_KEY}",
        "MACHINEN_API_URL": "https://machinen.redwoodjs.workers.dev"
      }
    }
  }
}
EOL
  echo "✓ Created MCP configuration at $GLOBAL_MCP_CONFIG"
fi

echo ""
echo "✓ Cursor hooks for Machinen ingest have been set up."
echo "✓ MCP server has been copied to $MCP_SERVER_TARGET_PATH"
echo ""
echo "Configuration:"
echo "  - MCP config: $GLOBAL_MCP_CONFIG (user-wide)"
echo "  - MCP server: $MCP_SERVER_TARGET_PATH"
echo ""
echo "⚠ IMPORTANT: Set the MACHINEN_API_KEY environment variable:"
echo "   export MACHINEN_API_KEY='your-api-key-here'"
echo ""
echo "   Or add it to your shell profile (~/.zshrc, ~/.bashrc, etc.)"
echo ""
echo "Please restart Cursor to apply the changes."
