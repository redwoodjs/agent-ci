# Manual Testing Guide: Code Origin API

This document describes how to manually test the Code Origin API endpoint and VS Code extension integration.

## Prerequisites

1. **API Access**

   - Machinen API URL (default: `https://machinen.redwoodjs.workers.dev`)
   - API key for authentication

2. **Git Repository**

   - A repository with commits that have been indexed in Machinen
   - At least one commit that is part of a pull request
   - The PR should be indexed in R2 at path: `github/<owner>/<repo>/pull-requests/<pr-number>/latest.json`

3. **VS Code Extension** (for extension testing)
   - Extension compiled and installed
   - Configuration set up in VS Code settings

## Testing the API Endpoint Directly

### Test 1: Basic API Call

**Setup:**

- Identify a file, line number, and commit hash from your repository
- Ensure the commit is part of a PR that has been indexed

**Steps:**

1. Make a POST request to `/api/gh/code-origin`:

```bash
curl -X POST https://machinen.redwoodjs.workers.dev/api/gh/code-origin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "file": "src/app/engine/routes.ts",
    "line": 26,
    "commitHash": "abc123def456...",
    "owner": "redwoodjs",
    "repo": "machinen"
  }'
```

**Expected Result:**

- Status: 200 OK
- Response: Plain text narrative explaining the decisions and timeline that led to the code's existence
- The narrative should reference:
  - The pull request number
  - Related GitHub issues, PRs, or Discord discussions
  - Timestamps and data sources
  - The sequence of events

### Test 2: Invalid Commit Hash

**Steps:**

1. Use a commit hash that doesn't exist or isn't part of a PR:

```bash
curl -X POST https://machinen.redwoodjs.workers.dev/api/gh/code-origin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "file": "src/app/engine/routes.ts",
    "line": 26,
    "commitHash": "0000000000000000000000000000000000000000",
    "owner": "redwoodjs",
    "repo": "machinen"
  }'
```

**Expected Result:**

- Status: 404 Not Found
- Response: "No pull request found for commit ..."

### Test 3: Missing Parameters

**Steps:**

1. Omit required parameters:

```bash
curl -X POST https://machinen.redwoodjs.workers.dev/api/gh/code-origin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "file": "src/app/engine/routes.ts",
    "line": 26
  }'
```

**Expected Result:**

- Status: 400 Bad Request
- Response: "Missing required parameters: file, line, commitHash, owner, repo"

### Test 4: Unindexed PR

**Steps:**

1. Use a commit from a PR that hasn't been indexed yet:

```bash
curl -X POST https://machinen.redwoodjs.workers.dev/api/gh/code-origin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "file": "some-file.ts",
    "line": 10,
    "commitHash": "valid-commit-hash",
    "owner": "redwoodjs",
    "repo": "machinen"
  }'
```

**Expected Result:**

- Status: 404 Not Found
- Response: "No indexed moments found for PR #X. The PR may not have been indexed yet."

### Test 5: Invalid API Key

**Steps:**

1. Use an incorrect or missing API key:

```bash
curl -X POST https://machinen.redwoodjs.workers.dev/api/gh/code-origin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer INVALID_KEY" \
  -d '{
    "file": "src/app/engine/routes.ts",
    "line": 26,
    "commitHash": "abc123...",
    "owner": "redwoodjs",
    "repo": "machinen"
  }'
```

**Expected Result:**

- Status: 401 Unauthorized
- Response: `{"error": "Unauthorized"}`

## Testing the VS Code Extension

### Setup

1. **Configure Extension Settings:**

   - Open VS Code Settings (Cmd/Ctrl + ,)
   - Search for "machinen"
   - Set `machinen.apiUrl` to your API URL
   - Set `machinen.apiKey` to your API key

2. **Compile Extension:**

   ```bash
   cd vscode-extension
   pnpm run compile
   ```

3. **Launch Extension Development Host:**
   - Open the extension folder in VS Code
   - Press F5 to launch Extension Development Host
   - A new VS Code window will open

### Test 6: Extension Integration - Successful Lookup

**Setup:**

- Open a file in a git repository
- Identify a line that was introduced in a PR that's been indexed
- Note the commit hash for that line (you can use `git blame`)

**Steps:**

1. In the Extension Development Host window, open a file
2. Navigate to a line of code
3. Type `//?` at the end of the line
4. Wait for the pop-over to appear

**Expected Result:**

- A webview panel opens showing:
  - **Code Origin & Decisions** section at the top with:
    - A narrative explaining why the code exists
    - References to related PRs, issues, or discussions
    - Timeline of decisions
  - **Git Blame Information** section below with:
    - Branch, author, hash, date
    - Commit message
    - Line history
    - File insights

### Test 7: Extension Integration - Uncommitted Line

**Steps:**

1. Open a file with uncommitted changes
2. Navigate to a line that has been modified but not committed
3. Type `//?` at the end of the line

**Expected Result:**

- The pop-over shows:
  - **Code Origin & Decisions** section with error: "Line is uncommitted or commit hash could not be determined"
  - **Git Blame Information** shows "uncommitted" status

### Test 8: Extension Integration - Missing Configuration

**Steps:**

1. Remove or clear the `machinen.apiKey` setting
2. Type `//?` on a line

**Expected Result:**

- The pop-over shows only Git Blame Information
- No Code Origin section appears
- Extension logs show: "Machinen API URL or API key not configured. Skipping code origin lookup."

### Test 9: Extension Integration - API Error

**Steps:**

1. Set `machinen.apiUrl` to an invalid URL
2. Type `//?` on a line

**Expected Result:**

- The pop-over shows:
  - **Code Origin & Decisions** section with error message
  - Error styling (red background/border)
  - **Git Blame Information** still displays normally

### Test 10: Extension Integration - Non-GitHub Repository

**Steps:**

1. Open a file in a repository that's not hosted on GitHub
2. Type `//?` on a line

**Expected Result:**

- The pop-over shows:
  - **Code Origin & Decisions** section with error: "Could not determine repository owner and name from git remote"
  - **Git Blame Information** still displays normally

## Verification Checklist

After running the tests, verify:

- [ ] API returns narratives for valid commits in indexed PRs
- [ ] API handles missing/invalid parameters correctly
- [ ] API returns appropriate error messages
- [ ] Extension displays code origin narrative when configured correctly
- [ ] Extension handles errors gracefully (shows error messages)
- [ ] Extension works with uncommitted lines
- [ ] Extension works with non-GitHub repositories (shows appropriate error)
- [ ] Extension logs are helpful for debugging
- [ ] Webview formatting is readable and well-structured

## Troubleshooting

### API Returns 404 for Valid Commits

- Verify the PR has been indexed: Check R2 for `github/<owner>/<repo>/pull-requests/<pr-number>/latest.json`
- Verify the commit is actually part of the PR (check GitHub)
- Check that the PR has moments in the Moment Graph (may need to re-index)

### Extension Shows "Could not determine repository owner and name"

- Verify git remote is configured: `git remote -v`
- Ensure remote URL follows GitHub format (https://github.com/owner/repo.git or git@github.com:owner/repo.git)

### Extension Shows API Errors

- Verify API URL is correct and accessible
- Verify API key is valid
- Check extension logs for detailed error messages
- Test the API directly with curl to isolate the issue

### Narrative is Empty or Generic

- Verify the PR has been indexed and has moments
- Check that related issues/PRs/Discord threads are also indexed
- The narrative quality depends on the richness of the Moment Graph data

## Notes

- The API uses the Moment Graph to find related decisions and timeline
- Response time depends on:
  - GitHub API response time (for commit-to-PR mapping)
  - R2 fetch time (for PR data)
  - Moment Graph query time
  - LLM synthesis time (can be several seconds)
- For best results, ensure PRs and related discussions are indexed before testing
