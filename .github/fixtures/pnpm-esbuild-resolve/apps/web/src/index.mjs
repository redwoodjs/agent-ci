import ms from "ms";

// Exercises esbuild resolution through pnpm workspace symlinks.
// In a pnpm monorepo, apps/web/node_modules/ms is a symlink to
// ../../node_modules/.pnpm/ms@2.x/node_modules/ms — esbuild must
// follow this chain correctly to bundle the file.
console.log(ms("1d"));
