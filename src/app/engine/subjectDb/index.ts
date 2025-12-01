import { SubjectDO } from "./durableObject";
import type { Subject } from "../types";
import { type Database, createDb } from "rwsdk/db";
import { type subjectMigrations } from "./migrations";

export { SubjectDO };

type SubjectDatabase = Database<typeof subjectMigrations>;
type SubjectDb = ReturnType<typeof createDb<SubjectDatabase>>;

export async function getSubject(
  db: SubjectDb,
  id: string
): Promise<Subject | null> {
  const row = await db
    .selectFrom("subjects")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    documentIds: (row.document_ids as unknown as string[]) || [],
    parentId: row.parent_id || undefined,
    childIds: (row.child_ids as unknown as string[] | undefined) || undefined,
    narrative: row.narrative || undefined,
    access_weight: row.access_weight || undefined,
  };
}

export async function putSubject(
  db: SubjectDb,
  subject: Subject
): Promise<void> {
  const existing = await db
    .selectFrom("subjects")
    .selectAll()
    .where("id", "=", subject.id)
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable("subjects")
      .set({
        title: subject.title,
        document_ids: JSON.stringify(subject.documentIds),
        parent_id: subject.parentId || null,
        child_ids: subject.childIds ? JSON.stringify(subject.childIds) : null,
        narrative: subject.narrative || null,
        access_weight: subject.access_weight || null,
      } as any)
      .where("id", "=", subject.id)
      .execute();
  } else {
    await db
      .insertInto("subjects")
      .values({
        id: subject.id,
        title: subject.title,
        document_ids: JSON.stringify(subject.documentIds),
        parent_id: subject.parentId || null,
        child_ids: subject.childIds ? JSON.stringify(subject.childIds) : null,
        narrative: subject.narrative || null,
        access_weight: subject.access_weight || null,
      } as any)
      .execute();
  }
}

export async function updateSubjectDocumentIds(
  db: SubjectDb,
  subjectId: string,
  documentId: string
): Promise<void> {
  const subject = await getSubject(db, subjectId);
  if (subject && !subject.documentIds.includes(documentId)) {
    subject.documentIds.push(documentId);
    await putSubject(db, subject);
  }
}
