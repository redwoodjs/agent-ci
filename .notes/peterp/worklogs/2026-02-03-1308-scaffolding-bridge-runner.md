---
title: Scaffolding Bridge and Runner Projects
date: 2026-02-03 13:08
author: peterp
---

# Scaffolding Bridge and Runner Projects

## Summary

Scaffolded two new projects: a Cloudflare Worker (Bridge) and a Local Process (Runner). Renamed them from original suggestions to avoid overloaded terminology.

## The Problem

The goal was to set up the foundation for a local GitHub Actions execution system including a central Cloudflare-based Orchestrator and a local agent.

## Investigation & Timeline

- **Initial State:** Empty monorepo root.
- **Attempts:**
  - Researched use of `pnpm create rwsdk` for the worker project.
  - Created `agent-ci-orchestrate` using the SDK starter.
  - Created `agent-ci-agent` as a basic Node workspace.
  - Renamed projects based on feedback: `orchestrate` -> `bridge` and `agent` -> `runner`.
  - Updated `package.json` names and internal scaffolding to match new naming convention.

## Discovery & Key Findings

- The term "Agent" is considered "super loaded" in this context, making "Runner" a more precise name for the local execution process.
- `pnpm create rwsdk` provides a robust boilerplate for Cloudflare Workers with Vite and React.

## Resolution

Final structure:

- `agent-ci-bridge`: RedwoodSDK Cloudflare Worker.
- `agent-ci-runner`: Node.js project for local task execution.

## Next Steps

- [ ] Implement Webhook Handler in `agent-ci-bridge`.
- [ ] Set up polling logic in `agent-ci-runner`.
- [ ] Configure Docker environment for execution.
