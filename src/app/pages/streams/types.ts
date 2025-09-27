export interface Stream {
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
  weeklyActivity: number[];
  lastUpdated: string;
  eventsThisWeek: number;
}

export interface StreamsListProps {
  streams: Stream[];
  onStreamSelect: (stream: Stream) => void;
}