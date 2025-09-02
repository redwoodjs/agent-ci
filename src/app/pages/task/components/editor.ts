import { createPlateEditor } from "platejs/react";
import { MarkdownPlugin, remarkMention, remarkMdx } from "@platejs/markdown";
import {
  HeadingPlugin,
  BoldPlugin,
  ItalicPlugin,
  UnderlinePlugin,
} from "@platejs/basic-nodes/react";

export const editor = createPlateEditor({
  plugins: [
    HeadingPlugin,
    BoldPlugin,
    ItalicPlugin,
    UnderlinePlugin,
    // ...other Plate plugins
    MarkdownPlugin.configure({
      options: {
        // Add remark plugins for syntax extensions (GFM, Math, MDX)
        remarkPlugins: [remarkMdx, remarkMention],
        // Define custom rules if needed
        rules: {
          // date: { /* ... rule implementation ... */ },
        },
      },
    }),
  ],
});
