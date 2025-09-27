import { StreamsList } from "./components/streams-list";
import { mockStreams } from "./mock-data";
import { Stream } from "./types";

export function StreamsListPage() {
  return <StreamsList streams={mockStreams} />;
}
