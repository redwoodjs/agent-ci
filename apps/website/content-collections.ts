import { defineCollection, defineConfig } from "@content-collections/core";
import { compileMarkdown } from "@content-collections/markdown";
import { z } from "zod";

const posts = defineCollection({
  name: "posts",
  directory: "./src/blog/content/",
  include: "*.md",
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    date: z.coerce.date(),
    author: z.string(),
    protected: z.boolean().optional(),
  }),
  transform: async (document, context) => {
    const html = await compileMarkdown(context, document); // HTML compilation for Workers
    return {
      ...document,
      html,
    };
  },
});

export default defineConfig({
  collections: [posts],
});
