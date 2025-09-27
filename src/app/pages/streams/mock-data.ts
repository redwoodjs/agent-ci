import { Stream } from './types';

export const mockStreams: Stream[] = [
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
    sourceCount: 20,
    weeklyActivity: [0.4, 0.6, 0, 0.8, 0.2, 0.6, 1],
    lastUpdated: '2h ago',
    eventsThisWeek: 12
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
    sourceCount: 15,
    weeklyActivity: [0.8, 1, 0.6, 1, 0.8, 1, 1],
    lastUpdated: '15m ago',
    eventsThisWeek: 31
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
    sourceCount: 32,
    weeklyActivity: [0, 0, 0.2, 0, 0.4, 0, 0.2],
    lastUpdated: '1d ago',
    eventsThisWeek: 3
  }
];