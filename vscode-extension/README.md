# Machinen

A VS Code extension that shows code origin and decisions when hovering over `//?` in code.

## Features

- Detects `//?` pattern in code
- Shows a hover pop-over when hovering over the pattern
- Executes a customizable callback function to retrieve information
- Works with all file types

## Setup

1. **Install dependencies:**

   ```bash
   cd vscode-extension
   pnpm install
   ```

2. **Compile the extension:**

   ```bash
   pnpm run compile
   ```

   Or use watch mode for development:

   ```bash
   pnpm run watch
   ```

## Testing the Extension

### Method 1: Using Extension Development Host (Recommended)

1. **Open the project in Cursor.** You can open either the root of the repository or the `vscode-extension` folder directly.
2. **Launch the extension:**
   - Go to the **Run and Debug** view (Ctrl+Shift+D / Cmd+Shift+D).
   - Select **Run Extension** from the dropdown menu.
   - Press **F5** or click the green arrow.
3. **Wait for compilation:** The extension will automatically compile using `pnpm run compile` before launching.
4. **Test in the new window:**
   - A new Cursor window will open (the Extension Development Host).
   - In the new window, open any file or create a test file.
   - Add `//?` to any line of code.
   - Hover your mouse over the `//?` pattern.
   - You should see a pop-over with information.

### Method 2: Package and Install

1. **Package the extension:**

   ```bash
   pnpm add -g @vscode/vsce
   vsce package
   ```

   This creates a `.vsix` file.

2. **Install the extension:**
   - Open VS Code
   - Go to Extensions view (Ctrl+Shift+X / Cmd+Shift+X)
   - Click the `...` menu and select "Install from VSIX..."
   - Select the generated `.vsix` file

## Customizing the Callback Function

The callback function `getInformationCallback()` in `src/extension.ts` can be customized to fetch information from any source. Currently, it's a placeholder that shows:

- The line content
- The file name
- A placeholder message

You can modify it to:

- Query APIs
- Search documentation
- Analyze code context
- Fetch data from databases
- Or any other information source

Example customization:

```typescript
function getInformationCallback(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();

  // Your custom logic here
  const customInfo = fetchYourInformation(document, position);

  markdown.appendMarkdown(`## Custom Info\n\n${customInfo}`);

  return markdown;
}
```

## Development

- **Compile:** `pnpm run compile`
- **Watch mode:** `pnpm run watch` (automatically recompiles on changes)
- **Debug:** Press `F5` in VS Code to launch Extension Development Host

## Project Structure

```
vscode-extension/
├── src/
│   └── extension.ts      # Main extension logic
├── package.json          # Extension manifest
├── tsconfig.json         # TypeScript configuration
└── README.md            # This file
```

## Requirements

- VS Code version 1.80.0 or higher
- Node.js and pnpm

## License

[Add your license here]
