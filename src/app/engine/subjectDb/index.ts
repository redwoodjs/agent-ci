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
    childIds: (row.child_ids ? JSON.parse(row.child_ids) : undefined) as
      | string[]
      | undefined,
    narrative: row.narrative ?? undefined,
    access_weight: row.access_weight ?? undefined,
  };
}

export async function putSubject(db: SubjectDb, subject: Subject) {
  const existing = await db
    .selectFrom("subjects")
    .where("id", "=", subject.id)
    .selectAll()
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable("subjects")
      .set({
        title: subject.title,
        document_ids: JSON.stringify(subject.documentIds),
        parent_id: (subject.parentId ?? null) as any,
        child_ids: (subject.childIds
          ? JSON.stringify(subject.childIds)
          : null) as any,
        narrative: (subject.narrative ?? null) as any,
        access_weight: (subject.access_weight ?? null) as any,
      })
      .where("id", "=", subject.id)
      .execute();
  } else {
    await db
      .insertInto("subjects")
      .values({
        id: subject.id,
        title: subject.title,
        document_ids: JSON.stringify(subject.documentIds),
        parent_id: (subject.parentId ?? null) as any,
        child_ids: (subject.childIds
          ? JSON.stringify(subject.childIds)
          : null) as any,
        narrative: (subject.narrative ?? null) as any,
        access_weight: (subject.access_weight ?? null) as any,
      })
      .execute();
  }
}

export async function updateSubjectDocumentIds(
  db: SubjectDb,
  subjectId: string,
  newDocumentId: string
) {
  const subject = await getSubject(db, subjectId);
  if (subject) {
    const updatedDocumentIds = Array.from(
      new Set([...subject.documentIds, newDocumentId])
    );
    await db
      .updateTable("subjects")
      .set({ document_ids: JSON.stringify(updatedDocumentIds) })
      .where("id", "=", subjectId)
      .execute();
  }
}

export async function getSubjectAncestors(
  db: SubjectDb,
  subjectId: string
): Promise<Subject[]> {
  const ancestors: Subject[] = [];
  let currentSubjectId: string | undefined = subjectId;

  while (currentSubjectId) {
    const subject = await getSubject(db, currentSubjectId);
    if (subject) {
      if (ancestors.length > 0) {
        // Avoid adding the starting subject twice
        ancestors.unshift(subject);
      }
      currentSubjectId = subject.parentId;
    } else {
      currentSubjectId = undefined;
    }
  }

  return ancestors;
}

export async function getSubjectChildren(
  db: SubjectDb,
  subjectId: string
): Promise<Subject[]> {
  const rows = await db
    .selectFrom("subjects")
    .selectAll()
    .where("parent_id", "=", subjectId)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    documentIds: (row.document_ids as unknown as string[]) || [],
    parentId: row.parent_id || undefined,
    childIds: (row.child_ids as unknown as string[] | undefined) || undefined,
    narrative: row.narrative || undefined,
    access_weight: row.access_weight || undefined,
  }));
}
