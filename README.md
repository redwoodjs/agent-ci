# Machinen, by RedwoodSDK

![Machinen Logo](./logo.svg)

_Note: This is a preview, it does not ship to production yet. (But should by 01-August-2025.)_

## What is Machinen?

![Machinen Application](./machinen-screenshot.png)

Machinen is a browser-based text editor that connects to a Cloudflare-hosted Docker instance running Vite and RedwoodSDK.
It gives developers a development environment in the cloud, designed for agentic workflows: Each workflow runs in its own isolated container, making it easy to edit, review, and merge changes independently of each other. Developers should self-host Machinen in their own Cloudflare environment.

## Quickstart

First start up Machinen:

```bash
pnpm install
pnpm dev
```

## TODO

- [ ] RAG the code.
- [ ] Reduce container size: Currently 1GB.
- [ ] Queue of tasks to complete to boot the container.

## Shortcomings

- Our editor is complete trash. We will improve it.
  - We want you to be able to directly communicate with the container via VSCode Dev Containers.

## Licensing

This is released under the FSL license.
