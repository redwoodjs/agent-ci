import { SqliteDurableObject } from "rwsdk/db";
import { migrations } from "./migrations";

export class GitHubRepoDurableObject extends SqliteDurableObject {
  migrations = migrations;
}
