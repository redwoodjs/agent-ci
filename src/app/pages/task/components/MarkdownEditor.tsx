"use client";

import { useState } from "react";

import type { Value } from "platejs";
import { Plate, PlateContent, usePlateEditor } from "platejs/react";

export function MarkdownEditor() {
  const editor = usePlateEditor();
  return (
    <Plate editor={editor}>
      <PlateContent
        style={{ padding: "16px 64px", minHeight: "100px" }}
        placeholder="Type your amazing content here..."
      />
    </Plate>
  );
}
