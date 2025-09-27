import { useState } from 'react';
import { StreamsList } from './components/StreamsList';
import { StreamDetail } from './components/StreamDetail';

interface Stream {
  id: string;
  name: string;
  description?: string;
  privacy: 'Private' | 'Shared';
  owner: string;
  coverage: number;
  freshness: 'Live' | 'Stale' | 'Fresh';
  subjects: number;
  agents: number;
  sourceCount: number;
}

const mockStreams: Stream[] = [
  {
    id: '1',
    name: 'Kysely Query Builder',
    description: 'TypeScript SQL query builder with type safety',
    privacy: 'Private',
    owner: 'goprzm',
    coverage: 85,
    freshness: 'Fresh',
    subjects: 12,
    agents: 3,
    sourceCount: 20
  },
  {
    id: '2',
    name: 'Zod Validation',
    description: 'Form submission and request validation',
    privacy: 'Shared',
    owner: 'goprzm',
    coverage: 92,
    freshness: 'Live',
    subjects: 8,
    agents: 2,
    sourceCount: 15
  },
  {
    id: '3',
    name: 'React Component Library',
    description: 'Reusable UI components for dashboard applications',
    privacy: 'Private',
    owner: 'goprzm',
    coverage: 76,
    freshness: 'Fresh',
    subjects: 18,
    agents: 4,
    sourceCount: 32
  }
];

export default function App() {
  const [currentView, setCurrentView] = useState<'list' | 'stream'>('stream');
  const [selectedStream, setSelectedStream] = useState<Stream | null>(mockStreams[0]);

  const handleStreamSelect = (stream: Stream) => {
    setSelectedStream(stream);
    setCurrentView('stream');
  };

  const handleBackToList = () => {
    setCurrentView('list');
    setSelectedStream(null);
  };

  return (
    <div className="min-h-screen bg-background">
      {currentView === 'list' ? (
        <StreamsList streams={mockStreams} onStreamSelect={handleStreamSelect} />
      ) : (
        <StreamDetail stream={selectedStream!} onBack={handleBackToList} />
      )}
    </div>
  );
}