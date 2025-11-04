# 2025-11-03: Cursor Ingestion

## Problem

I want to capture interactions with Cursor as a data source for our organization's memory system. This involves storing entire conversations, per branch, to understand the development process, particularly the collaboration between human developers and AI. We need a way to track which file changes are authored by AI versus a human.

## Context

The overall project is an organizational memory system with various data ingestion sources. This task focuses on building the ingestion mechanism for Cursor.

-   **Data Storage**: The raw, unstructured data from Cursor should be stored in the `MACHINEN_BUCKET` R2 bucket. The goal is to capture as much data as possible in its original JSON format.
-   **Statefulness**: If any state needs to be managed during the ingestion process, `rwsdk/db` can be used.
-   **Cursor Hooks**: Cursor provides a "Hooks" feature that allows running custom scripts at different stages of the agent loop. This seems to be the primary mechanism for extracting conversation data.
-   **Setup**: The solution must include a way to set up these hooks for any given repository, not just this one. This suggests a need for user-runnable setup scripts.

The existing `discord` ingestor (`src/app/ingestors/discord/`) can serve as a structural reference, but I am not strictly bound to follow it.

## Plan

The plan is to use Cursor's hooks to send conversation data to a webhook, which then stores the raw data in an R2 bucket.

### Tasks

1.  **Research Cursor Hooks**: Analyze the Cursor Hooks documentation to identify the specific hooks needed to capture a complete conversation (user prompts, agent responses, tool calls, file edits). Determine the data payload for each hook and devise a strategy for reconstructing the conversation from these events.

2.  **Design and Implement Ingestion Endpoint**: Create a new route in the application that acts as a webhook endpoint. This endpoint will receive JSON payloads from the Cursor hook scripts and write them to the `MACHINEN_BUCKET` R2 bucket. The objects in R2 could be organized by `conversation_id`.

3.  **Create Hook Script**: Write a simple shell script that can be executed by Cursor's hooks. This script will read the JSON data from standard input and `POST` it to the ingestion endpoint.

4.  **Develop Setup Script**: Create a script that automates the setup of the Cursor hooks for a user. This script will:
    -   Create or update `~/.cursor/hooks.json` to register the necessary hooks.
    -   Place the hook script into `~/.cursor/hooks/`.
    -   Ensure the hook script is executable.

5.  **Implementation and Testing**:
    -   Create a new ingestor module under `src/app/ingestors/cursor/`.
    -   Implement the endpoint and associated services.
    -   Place the hook and setup scripts within the module.
    -   Test the end-to-end flow by running the setup script, interacting with Cursor in this repository, and verifying that the data is correctly ingested and stored in R2.
