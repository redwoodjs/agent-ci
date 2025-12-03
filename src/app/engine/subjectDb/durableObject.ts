import { SqliteDurableObject } from "rwsdk/db";
import { subjectMigrations } from "./migrations";

export class SubjectDO extends SqliteDurableObject {
  migrations = subjectMigrations;
}
