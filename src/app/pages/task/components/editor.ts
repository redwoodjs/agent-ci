import { createPlateEditor } from "platejs/react";
import { MarkdownPlugin, remarkMention, remarkMdx } from "@platejs/markdown";
// import remarkGfm from 'remark-gfm';
// import remarkMath from 'remark-math';

const editor = createPlateEditor({
  plugins: [
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
