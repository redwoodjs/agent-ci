import { SqliteDurableObject } from "rwsdk/db";
import { migrations } from "./migrations";

interface CursorEvent {
  conversation_id: string;
  generation_id: string;
  hook_event_name: string;
  [key: string]: any;
}

export class CursorEventsDurableObject extends SqliteDurableObject {
  migrations = migrations;

  async addEvent(event: CursorEvent) {
    await this.db
      .insertInto("events")
      .values({
        event_data: JSON.stringify(event),
        timestamp: new Date().toISOString(),
      })
      .execute();
  }

  async finalize(bucket: R2Bucket) {
    const eventsResult = await this.db
      .selectFrom("events")
      .selectAll()
      .orderBy("timestamp", "asc")
      .execute();

    if (eventsResult.length === 0) {
      return;
    }

    const events: CursorEvent[] = eventsResult.map((row) =>
      JSON.parse(row.event_data)
    );
    const { conversation_id, generation_id } = events[0];
    const key = `cursor-conversations-v2/${conversation_id}/${generation_id}.json`;

    const aggregatedData = {
      conversation_id,
      generation_id,
      events,
    };

    await bucket.put(key, JSON.stringify(aggregatedData, null, 2));
    await this.db.deleteFrom("events").execute();
  }
}
