import { SqliteDurableObject } from "rwsdk/db";
import { subjectMigrations } from "./migrations";

export class SubjectGraphDO extends SqliteDurableObject {
  migrations = subjectMigrations;
}

