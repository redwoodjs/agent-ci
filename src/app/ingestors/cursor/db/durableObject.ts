import { SqliteDurableObject } from "rwsdk/db";
import { migrations } from "./migrations";

export class CursorEventsDurableObject extends SqliteDurableObject {
  migrations = migrations;
}
