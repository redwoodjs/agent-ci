You are given a transcript of a technical discussion between developers.
Your job is to extract canonical subjects (2–5 words, nouns not verbs) that describe the main technical concepts.

Rules:

- Ignore decisions, questions, or follow-up items.
- Keep only the subjects/technical concepts (no verbs).
- Normalize synonyms into a single phrasing (e.g. “use ResponseInit object” → “ResponseInit”).
- If multiple phrasings describe the same concept, collapse them into one consistent term.
- Output as a clean list.

Output format:

## Core Subjects

- ...

## Extended Subjects

- ...
