import { getTranscriptsFromR2 } from "./actions";
import { CreateSampleTranscriptButton } from "./components/CreateSampleTranscriptButton";
import { GenerateTranscriptsButton } from "./components/GenerateTranscriptsButton";
import { TranscriptSearchInterface } from "./components/TranscriptSearchInterface";
import { DeleteTranscriptButton } from "./components/DeleteTranscriptButton";

interface TranscriptEntry {
  id: string;
  timestamp: string;
  speaker: string;
  text: string;
  confidence: number;
}

interface MockTranscript {
  id: string;
  meetingId: string;
  title: string;
  createdAt: string;
  duration: number;
  participants: string[];
  entries: TranscriptEntry[];
}



export async function TranscriptPage({
  params,
}: {
  params: { containerId: string };
}) {
  const { containerId } = params;

  // Load saved transcripts from R2
  const savedTranscriptsResult = await getTranscriptsFromR2(containerId);
  const transcripts = savedTranscriptsResult.success
    ? savedTranscriptsResult.transcripts
    : [];

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">Meeting Transcripts</h1>
        <p className="text-gray-600">
          Audio transcripts from meetings and discussions for container:{" "}
          {containerId}
        </p>
      </div>

      {/* AI Search Interface - Always visible */}
      <div className="mb-8">
        <TranscriptSearchInterface containerId={containerId} />
      </div>

      {transcripts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">No transcripts available yet.</p>
          <p className="text-sm text-gray-400 mb-6">
            Transcripts will appear here once they are saved to R2 storage.
          </p>
          <div className="space-y-3">
            <CreateSampleTranscriptButton containerId={containerId} />
            <GenerateTranscriptsButton containerId={containerId} />
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {transcripts.map((transcript) => (
            <div key={transcript.id} className="border rounded-lg p-6">
              <div className="mb-4">
                <h2 className="text-xl font-semibold mb-2">
                  {transcript.title}
                </h2>
                <div className="text-sm text-gray-600 space-y-1">
                  <p>Meeting ID: {transcript.meetingId}</p>
                  <p>Date: {new Date(transcript.createdAt).toLocaleString()}</p>
                  <p>
                    Duration: {Math.floor(transcript.duration / 60)} minutes
                  </p>
                  <p>Participants: {transcript.participants.join(", ")}</p>
                </div>
                <DeleteTranscriptButton
                  containerId={containerId}
                  transcriptId={transcript.id}
                  transcriptTitle={transcript.title}
                />
              </div>

              <div className="space-y-3">
                {transcript.entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex gap-4 p-3 bg-gray-50 rounded"
                  >
                    <div className="flex-shrink-0 w-20">
                      <div className="text-sm font-medium text-blue-600">
                        {entry.speaker}
                      </div>
                      <div className="text-xs text-gray-500">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                    <div className="flex-1">
                      <p className="text-gray-900">{entry.text}</p>
                      <div className="text-xs text-gray-500 mt-1">
                        Confidence: {(entry.confidence * 100).toFixed(1)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
