"use client";

import Monaco from "@monaco-editor/react";
import { useImperativeHandle, useRef } from "react";

// Language detection for RedwoodSDK file types
function getLanguageFromPath(pathname: string): string {
  const extension = pathname.substring(pathname.lastIndexOf("."));

  const languageMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".css": "css",
    ".scss": "scss",
    ".html": "html",
    ".json": "json",
    ".md": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
  };

  return languageMap[extension] || "plaintext";
}

interface MonacoEditorProps {
  content: string;
  pathname: string;
  onChange: (value: string) => void;
  onSave: (content: string) => Promise<void>;
  onModifiedChange: (isModified: boolean) => void;
  ref?: React.Ref<{
    updateOriginalContent: (content: string) => void;
    getCurrentContent: () => string;
  }>;
}

export function MonacoEditorContainer({
  content,
  pathname,
  onChange,
  onSave,
  onModifiedChange,
  ref,
}: MonacoEditorProps) {
  const originalContentRef = useRef(content);

  const editorRef = useRef<any>(null);

  useImperativeHandle(ref, () => ({
    updateOriginalContent: (newContent: string) => {
      originalContentRef.current = newContent;
      onModifiedChange(false);
    },
    getCurrentContent: () => {
      return editorRef.current?.getValue() || "";
    },
  }));

  if (!pathname) {
    return null;
  }

  return (
    <Monaco
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        originalContentRef.current = content;

        // Configure TypeScript compiler options for better IntelliSense
        monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
          target: monaco.languages.typescript.ScriptTarget.ES2020,
          lib: ["es2020", "dom", "dom.iterable"],
          allowNonTsExtensions: true,
          moduleResolution:
            monaco.languages.typescript.ModuleResolutionKind.NodeJs,
          module: monaco.languages.typescript.ModuleKind.ESNext,
          noEmit: true,
          esModuleInterop: true,
          jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
          allowJs: true,
          strict: false, // Reduce strictness to avoid false positives
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
        });

        // Configure TypeScript diagnostics
        monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
          noSemanticValidation: true, // Disable semantic validation (import errors, type checking)
          noSyntaxValidation: false, // Keep syntax validation enabled
          noSuggestionDiagnostics: false,
        });

        // Create proper TypeScript model with correct URI
        const language = getLanguageFromPath(pathname);
        const uri = monaco.Uri.file(pathname);

        // Dispose existing model if it exists
        const existingModel = monaco.editor.getModel(uri);
        if (existingModel) {
          existingModel.dispose();
        }

        // Create new model with proper language and URI
        const model = monaco.editor.createModel(content, language, uri);
        editor.setModel(model);

        // Track content changes and dirty state
        model.onDidChangeContent(() => {
          const currentContent = editor.getValue();
          const isModified = currentContent !== originalContentRef.current;
          onModifiedChange(isModified);
        });

        // Add save action with Cmd+S shortcut
        const filename = pathname.split("/").pop() || pathname;
        editor.addAction({
          id: "save-file",
          label: `Save ${filename}`,
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: async () => {
            const currentContent = editor.getValue();
            await onSave(currentContent);
            // Update the original content reference after saving
            originalContentRef.current = currentContent;
            onModifiedChange(false);
          },
        });
      }}
      className="flex h-full"
      theme="vs-light"
      options={{
        minimap: {
          enabled: false,
        },
        fontSize: 14,
        lineHeight: 20,
        automaticLayout: true,
      }}
      onChange={(value) => {
        if (value !== undefined) {
          onChange(value);
        }
      }}
      value={content}
    />
  );
}
