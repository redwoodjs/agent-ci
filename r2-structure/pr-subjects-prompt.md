You are given a pull request with a title, body, comments, and commits.
Your job is to extract canonical subjects (2–5 words, nouns not verbs) that describe the main technical concepts.

Rules:

- Use the PR title + body as the primary source for subjects.
- Use comments/reviews only if they highlight new important concepts.
- Ignore or down-weight commit messages, unless they introduce a new concept not already in the body.
- Normalize synonyms (e.g. “useId mismatch” vs. “useId desync” → “useId hydration mismatch”).
- Keep subjects concise (2–5 words).
- Separate into two tiers:
  - Core Subjects: 5–7 most central concepts (problem, cause, solution, key mechanisms).
  - Extended Subjects: Optional supporting concepts (tests, docs, secondary implementation details).

Output format:

## Core Subjects

- ...

## Extended Subjects

- ...
