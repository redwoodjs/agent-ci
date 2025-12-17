import { SubjectDO } from "./durableObject";
import { type Database, createDb } from "rwsdk/db";
import { type subjectMigrations } from "./migrations";
import { Override } from "@/app/shared/kyselyTypeOverrides";

export { SubjectDO };

type SubjectDatabase = Database<typeof subjectMigrations>;
type SubjectInput = SubjectDatabase["subjects"];
type SubjectDb = ReturnType<typeof createDb<SubjectDatabase>>;

export type Subject = Override<
  SubjectInput,
  {
    document_ids: string[];
    child_ids: string[] | null;
  }
>;

export async function getSubject(
  db: SubjectDb,
  id: string
): Promise<Subject | null> {
  const row = (await db
    .selectFrom("subjects")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) as Subject | undefined;

  return row ?? null;
}

export async function getSubjectByIdempotencyKey(
  db: SubjectDb,
  idempotencyKey: string
): Promise<Subject | null> {
  const row = (await db
    .selectFrom("subjects")
    .selectAll()
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst()) as Subject | undefined;

  return row ?? null;
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
        document_ids: JSON.stringify(subject.document_ids) as any,
        parent_id: subject.parent_id,
        child_ids: (subject.child_ids
          ? JSON.stringify(subject.child_ids)
          : null) as any,
        narrative: subject.narrative,
        access_weight: subject.access_weight,
        idempotency_key: subject.idempotency_key,
      })
      .where("id", "=", subject.id)
      .execute();
  } else {
    await db
      .insertInto("subjects")
      .values({
        id: subject.id,
        title: subject.title,
        document_ids: JSON.stringify(subject.document_ids) as any,
        parent_id: subject.parent_id,
        child_ids: (subject.child_ids
          ? JSON.stringify(subject.child_ids)
          : null) as any,
        narrative: subject.narrative,
        access_weight: subject.access_weight,
        idempotency_key: subject.idempotency_key,
      })
      .execute();
  }
}

export async function updateSubjectDocumentIds(
  db: SubjectDb,
  subjectId: string,
  documentIds: string[]
) {
  const subject = await getSubject(db, subjectId);
  if (!subject) {
    console.warn(
      `[subjectDb] updateSubjectDocumentIds: Subject ${subjectId} not found.`
    );
    return;
  }

  const existingDocIds = new Set(subject.document_ids);
  for (const docId of documentIds) {
    existingDocIds.add(docId);
  }

  const documentIdsJson = JSON.stringify(Array.from(existingDocIds));
  await db
    .updateTable("subjects")
    .set({ document_ids: documentIdsJson })
    .where("id", "=", subject.id)
    .execute();
  console.log(
    `[subjectDb] Updated subject ${subjectId} with new document IDs. Total: ${existingDocIds.size}`
  );
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
      currentSubjectId = subject.parent_id ?? undefined;
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
  const rows = (await db
    .selectFrom("subjects")
    .selectAll()
    .where("parent_id", "=", subjectId)
    .execute()) as unknown as Subject[];

  return rows;
}

export async function listSubjects(
  db: SubjectDb,
  limit: number = 50,
  offset: number = 0
): Promise<{ subjects: Subject[]; total: number }> {
  const rows = await db
    .selectFrom("subjects")
    .selectAll()
    .limit(limit)
    .offset(offset)
    .execute();

  const totalResult = await db
    .selectFrom("subjects")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .executeTakeFirst();

  return {
    subjects: rows as unknown as Subject[],
    total: totalResult?.count ?? 0,
  };
}
