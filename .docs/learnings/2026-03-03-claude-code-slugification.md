# Claude Code Slugification Replaces Both `/` and `_`

## Problem

`derive` was unable to discover conversations for repositories with underscores in their cwd path (e.g. `opposite-actions_specs`). The `getSlugDir` function computed a slug directory that did not match Claude Code's actual directory on disk.

## Finding

Claude Code's slugification of the cwd path replaces **both `/` and `_` with `-`**, not just `/` as originally documented. This was verified empirically across multiple project directories in `~/.claude/projects/`.

Examples:

- `/Users/justin/rw/worktrees/opposite-actions_specs` → `-Users-justin-rw-worktrees-opposite-actions-specs`
- `machinen_log-ui-poll` → `machinen-log-ui-poll`
- `sdk_dipankarmaikap-fix-handel-windows-path` → `sdk-dipankarmaikap-fix-handel-windows-path`

## Solution

The slug computation must use `cwd.replace(/[/_]/g, "-")` instead of `cwd.replace(/\//g, "-")`.

## Context

Discovered during investigation of "no new messages" bug in derive. The slug mismatch caused `discoverConversations` to look in a non-existent directory and silently return zero files.
