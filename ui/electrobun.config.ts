import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "hello-world",
    identifier: "helloworld.electrobun.dev",
    version: "0.0.1",
  },
  build: {
    views: {
      repos: {
        entrypoint: "src/mainview/repos.ts",
      },
      commits: {
        entrypoint: "src/mainview/commits.ts",
      },
      workflows: {
        entrypoint: "src/mainview/workflows.ts",
      },
    },
    copy: {
      "src/mainview/repos.html": "views/repos/index.html",
      "src/mainview/commits.html": "views/commits/index.html",
      "src/mainview/workflows.html": "views/workflows/index.html",
      "src/mainview/repos.css": "views/repos/repos.css",
      "src/mainview/commits.css": "views/commits/commits.css",
      "src/mainview/workflows.css": "views/workflows/workflows.css",
      "src/assets/tray.png": "assets/tray.png",
    },
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
