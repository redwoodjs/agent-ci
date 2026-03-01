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
      branches: {
        entrypoint: "src/mainview/branches.ts",
      },
      runs: {
        entrypoint: "src/mainview/runs.ts",
      },
    },
    copy: {
      "src/mainview/repos.html": "views/repos/index.html",
      "src/mainview/commits.html": "views/commits/index.html",
      "src/mainview/workflows.html": "views/workflows/index.html",
      "src/mainview/branches.html": "views/branches/index.html",
      "src/mainview/runs.html": "views/runs/index.html",
      "src/mainview/repos.css": "views/repos/repos.css",
      "src/mainview/commits.css": "views/commits/commits.css",
      "src/mainview/workflows.css": "views/workflows/workflows.css",
      "src/mainview/branches.css": "views/branches/branches.css",
      "src/mainview/runs.css": "views/runs/runs.css",
      "src/assets/tray.png": "assets/tray.png",
      "src/assets/tray-idle.png": "assets/tray-idle.png",
      "src/assets/tray-running.png": "assets/tray-running.png",
      "src/assets/tray-passed.png": "assets/tray-passed.png",
      "src/assets/tray-failed.png": "assets/tray-failed.png",
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
