import { type RequestInfo } from "rwsdk/worker";
import { getTranscriptsFromR2 } from "./actions";
import { CreateSampleTranscriptButton } from "./components/CreateSampleTranscriptButton";
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

// Helper function to create sample transcript data
function createSampleTranscript(): MockTranscript {
  return {
    id: `transcript-${Date.now()}`,
    meetingId: `meeting-${Date.now()}`,
    title: "Sample Meeting Transcript",
    createdAt: new Date().toISOString(),
    duration: 1800, // 30 minutes
    participants: ["Peter", "Herman", "Alice"],
    entries: [
      {
        id: "entry-1",
        timestamp: new Date().toISOString(),
        speaker: "Peter",
        text: "I want to add a new route called 'ping' that returns 'pong' as a response.",
        confidence: 0.95,
      },
      {
        id: "entry-2",
        timestamp: new Date(Date.now() + 7000).toISOString(),
        speaker: "Herman",
        text: "I don't know why you want to do that?",
        confidence: 0.92,
      },
      {
        id: "entry-3",
        timestamp: new Date(Date.now() + 13000).toISOString(),
        speaker: "Peter",
        text: "Because I want to demo this thing to people, don't you understand what we're trying to build man?",
        confidence: 0.88,
      },
      {
        id: "entry-4",
        timestamp: new Date(Date.now() + 20000).toISOString(),
        speaker: "Herman",
        text: "I do kinda get it, but is this a good demo?",
        confidence: 0.94,
      },
      {
        id: "entry-5",
        timestamp: new Date(Date.now() + 26000).toISOString(),
        speaker: "Peter",
        text: "Trust me.",
        confidence: 0.98,
      },
    ],
  };
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

      {transcripts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">No transcripts available yet.</p>
          <p className="text-sm text-gray-400 mb-6">
            Transcripts will appear here once they are saved to R2 storage.
          </p>
          <CreateSampleTranscriptButton containerId={containerId} />
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
