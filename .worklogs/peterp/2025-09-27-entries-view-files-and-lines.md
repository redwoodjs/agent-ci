Date: 2025-09-27
Title: Entries page – switch to files with subject-annotated line ranges

Context
The existing Entries view renders a sources table. The new requirement is a files list where important line ranges are associated with subjects, showing short excerpts without loading entire files.

Investigation

- Checked routing for stream detail subpages and found /entries already wired.
- Searched for subject-related components and found mock subjects view; no existing DB schema for subjects or file-line entries.
- Looked for code/lines viewers; the editor page uses Monaco, but not suitable for static server-rendered snippets.

Decision

- Implement a server-rendered list with mock data to represent files and annotated line ranges with subject badges and excerpts.
- Add an architecture document describing the future schema (files, subjects, file_entries) and UI contract.

Next Steps

- Replace EntriesView table with a list layout: file path header, subject badges, code excerpt with line numbers and highlighted range.
- Use static mock data within the EntriesView for now; keep interfaces explicit for later wiring to DB.
