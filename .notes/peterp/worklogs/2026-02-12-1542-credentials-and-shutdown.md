---
title: Fixing Runner Credentials and Implementing Graceful Shutdown
date: 2026-02-12 15:42
author: peterp
---

# Fixing Runner Credentials and Implementing Graceful Shutdown

## Summary
We resolved a critical startup failure caused by missing RSA credentials and implemented a graceful shutdown mechanism. The runner now correctly mounts all required authentication files and automatically removes its "warm" Docker container when the process exits.

## The Problem
1.  **Missing Credentials**: The runner crashed with `CryptographicException: RSA key file ... not found`. We discovered that `.credentials_rsaparams` was missing from our volume mounts and initially missing from the source directory.
2.  **Orphaned Containers**: Stopping the runner script (via Ctrl+C) left the `warm-runner` Docker container running, forcing manual cleanup before the next run.

## Investigation & Timeline
*   **Initial State**: The runner was failing to authenticate with GitHub.
*   **Attempts**:
    *   **Credential Recovery**: We identified `runner/actions-runner` as the expected source for credentials. After some confusion with missing directories, we located the correct `.credentials_rsaparams` file.
    *   **Mount Fix**: We updated `warm-pool.ts` to explicitly mount `.credentials_rsaparams` into the container, as mounting the parent directory masked the binary files.
    *   **Graceful Shutdown**: We added a `stopWarmPool` function to `src/warm-pool.ts` that clears the polling interval and removes the container. We then updated `src/index.ts` to listen for `SIGINT` and `SIGTERM` signals.

## Discovery & Key Findings
*   **Explicit Mounts**: When using a pre-built image with existing binaries (like `actions-runner`), you must mount configuration files individually rather than mounting a whole directory over existing content.
*   **Signal Handling**: Node.js processes starting Docker containers need explicit signal handlers to clean up resources, as the containers run independently of the parent process.

## How to Obtain Credentials
The runner credentials (`.runner`, `.credentials`, `.credentials_rsaparams`) are generated when you register a self-hosted runner with GitHub.

1.  **Go to GitHub**: Navigate to **Settings** > **Actions** > **Runners** > **New self-hosted runner**.
2.  **Download & Configure**: Follow the instructions to download the runner package and run the `config.sh` script.
    ```bash
    ./config.sh --url https://github.com/redwoodjs/opposite-actions --token <YOUR_TOKEN>
    ```
3.  **Extract Credentials**: After configuration, the credentials files are created in the runner directory. Copy them to your local identity folder:
    ```bash
    cp .runner .credentials .credentials_rsaparams ~/gh/redwoodjs/oa-1/runner/_/identity/
    ```

## Resolution
1.  **Updated `warm-pool.ts`**: Added mount for `.credentials_rsaparams` and implemented `stopWarmPool()`.
2.  **Updated `index.ts`**: Added `process.on('SIGINT', ...)` handlers to trigger cleanup.

## Next Steps
- [ ] Implement job claiming logic within the warm container.
