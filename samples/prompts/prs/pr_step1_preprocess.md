# Step 1 (Pull Requests): Preprocess and Normalize

Before prompting, normalize raw PR data from GitHub/GitLab so downstream steps are deterministic and comparable.

## Recommended unified object per PR
```json
{
  "repo": "org/project",
  "pr_number": 123,
  "url": "https://...",
  "state": "open",                 // open | closed | merged
  "title": "Fix duplicate symbols error in Alpha 3",
  "body": "Detailed PR description...",
  "author": "justin",
  "assignees": ["justin"],
  "labels": ["bug", "deployment"],
  "milestone": "v0.1",
  "created_at": "2025-09-20T09:00:00Z",
  "updated_at": "2025-09-21T14:00:00Z",
  "merged_at": "2025-09-21T15:00:00Z",

  "commits": [
    {
      "sha": "abc123",
      "title": "fix: guard symbol export in build step",
      "message": "…full message…",
      "author": "justin",
      "authored_at": "2025-09-20T10:00:00Z"
    }
  ],

  "files_changed": [
    {
      "path": "packages/runtime/build.ts",
      "status": "modified",        // added | modified | removed | renamed
      "additions": 42,
      "deletions": 5
    }
  ],

  "reviews": [
    {
      "reviewer": "amy",
      "state": "APPROVED",         // APPROVED | CHANGES_REQUESTED | COMMENTED
      "submitted_at": "2025-09-20T12:00:00Z"
    }
  ],

  "comments": [
    {
      "id": "c_1",
      "author": "peter",
      "ts": "2025-09-20T11:05:00Z",
      "text": "Does this fix production deploys on Alpha 3?",
      "in_reply_to": null,
      "thread_key": "general"
    },
    {
      "id": "c_2",
      "author": "justin",
      "ts": "2025-09-20T11:10:00Z",
      "text": "Yes; added a guard in build.ts.",
      "in_reply_to": "c_1",
      "thread_key": "general"
    }
  ]
}
```

## Preprocessing rules
1. **Flatten**: collect title, body, commits, diffs, reviews, comments, labels, assignees.
2. **Chronology**: sort commits/comments/reviews by timestamp; assign `line` numbers.
3. **Threads**: preserve review threads via `thread_key`; default to "general" if not provided.
4. **Text cleanup**: normalize markdown → plain text; **preserve code blocks & file paths**.
5. **References**: normalize artifact references ("PR #123" → "pr#123").
6. **File paths**: keep literal (do not lowercase). Use forward slashes.
7. **Review state**: collect approval quorum (≥2 APPROVED by default).
8. **State**: annotate terminal outcome (`merged`/`closed`) and timestamps.
9. **Sidecar**: maintain `{ line → comment.id }` mapping for `evidence_comment_ids`.
