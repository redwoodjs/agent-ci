import { SqliteDurableObject } from "rwsdk/db";

import { migrations } from "./migrations";

export class Database extends SqliteDurableObject {
  migrations = migrations;
}
