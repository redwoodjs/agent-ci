import { Stream } from '../../../types';

interface ConversationViewProps {
  stream: Stream;
}

export function ConversationView({ stream }: ConversationViewProps) {
  return (
    <div className="flex-1 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="text-center py-12">
          <h2 className="text-xl font-semibold mb-2">Welcome to {stream.name}</h2>
          <p className="text-muted-foreground mb-6">
            Ask questions about this stream's subjects and get intelligent responses.
          </p>
          <div className="bg-muted/50 rounded-lg p-8">
            <p className="text-sm text-muted-foreground">
              Start a conversation by typing in the input field above.
              This AI assistant has access to {stream.subjects} subjects and {stream.sourceCount} sources
              to help answer your questions.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}