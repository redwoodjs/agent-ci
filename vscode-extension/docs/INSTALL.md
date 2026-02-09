# Installing Machinen VS Code Extension

To install the Machinen VS Code extension in other projects, you need to package it into a `.vsix` file and then install that file in your VS Code instance.

## Prerequisites

- **Node.js** and **pnpm** installed on your system.
- **VS Code** (or Cursor) version 1.80.0 or higher.
- **Google Antigravity** extension must be installed in VS Code as Machinen depends on it.

## Packaging the Extension

1.  **Navigate to the extension directory:**
    ```bash
    cd vscode-extension
    ```

2.  **Install dependencies:**
    ```bash
    pnpm install
    ```

3.  **Package the extension:**
    ```bash
    pnpm run package
    ```
    This will generate a file named `machinen-0.0.1.vsix` (the version may vary) in the `vscode-extension` directory.

## Installing in VS Code

1.  Open VS Code (or Cursor).
2.  Open the **Extensions** view (`Cmd+Shift+X`).
3.  Click the **...** (More Actions) menu in the top right of the Extensions view.
4.  Select **Install from VSIX...**.
5.  Navigate to and select the `machinen-0.0.1.vsix` file you generated.

Once installed, the extension will be available in all your VS Code projects!

## Development / Quick Test

If you just want to test it in another project without a full installation:
1.  Open the `machinen` project in VS Code.
2.  Press `F5` to start the **Extension Development Host**.
3.  In the new window that opens, you can open any other project and test the extension features (hover over `//?`).
