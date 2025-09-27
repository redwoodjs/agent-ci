Title: Entries Page – Files with Subject-Annotated Line Ranges

Problem

- The Entries page should display a list of files.
- Each file lists one or more important line ranges.
- Each line range is associated with one or more subjects.

Scope

- Server-rendered list view for a stream: minimal interactivity.
- Start with mock data. Add persistence and ingestion later.

Data Model (proposed)

- files: id, streamId, path, repoUrl?, lastIndexedAt
- file_entries: id, fileId, lineStart, lineEnd, subjectId, importance, excerptText, createdAt
- subjects: id, name, description?

Notes

- Store excerptText for the rendered snippet to avoid fetching entire files on view.
- Keep lineStart/lineEnd 1-based to match editor UIs.
- A file may have multiple entries across different subjects; entries can overlap.

Server Component Contract

- Input: streamID (from route params).
- Query shape (initially mocked):
  [{
  filePath: string,
  entries: [{ lineStart: number, lineEnd: number, subjects: string[], excerptText: string }]
  }]
- Pagination: simple limit/offset per request (add later if needed).

UI Structure

- Vertical list of files.
- For each file:
  - file path (monospace), optional repo link.
  - list of entry chips: subject badges next to a short line range label.
  - code excerpt block with a slim gutter showing line numbers; highlight the range.

Routing

- Route already exists at /streams/:streamID/entries.
- Replace current table-based EntriesView with the files/entries list.

Migration Plan (later phase)

1. Add tables: files, subjects, file_entries.
2. Add indexes: files(streamId, path), file_entries(fileId), file_entries(subjectId).
3. Ingestion: write a job to upsert files and file_entries from analysis output.

Open Questions

- Source of subjects: PR analysis/transcripts vs user-defined. Start with user-defined rows.
- Excerpt generation: fixed window around lineStart/lineEnd vs precomputed snippet. Start with stored excerptText.

Risks

- Large files; avoid loading entire file content server-side by using stored excerpts.
- Many entries per file; collapse sections and lazy-render long lists if needed later.

Deliverable (this iteration)

- Replace EntriesView with mock-backed files/entries list matching the described layout and interactions kept minimal.
