import { StreamHeader } from "./components/stream-header";
import { LeftRail } from "./components/left-rail";
import { SourcesView } from "./views/sources-view";
import { mockStreams } from "../../mock-data";

interface SourcesPageProps {
  params: {
    streamID: string;
  };
}

export function SourcesPage({ params }: SourcesPageProps) {
  const stream = mockStreams.find((s) => s.id === params.streamID);

  const handleBack = () => {
    window.location.href = "/streams";
  };

  if (!stream) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Stream not found</h1>
          <p className="text-muted-foreground">
            The stream you're looking for doesn't exist.
          </p>
          <a
            href="/streams"
            className="text-blue-600 hover:underline mt-4 inline-block"
          >
            Back to streams
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <StreamHeader stream={stream} />

      <div className="flex h-[calc(100vh-80px)]">
        <LeftRail activeSection="sources" stream={stream} />

        <SourcesView stream={stream} />
      </div>
    </div>
  );
}
