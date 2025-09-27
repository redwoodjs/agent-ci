import { ConversationView } from './ConversationView';
import { SourcesView } from './SourcesView';
import { TimelineView } from './TimelineView';
import { SubjectsView } from './SubjectsView';
import { AgentsView } from './AgentsView';
import { AutomationsView } from './AutomationsView';

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

interface MainContentProps {
  activeSection: string;
  stream: Stream;
}

export function MainContent({ activeSection, stream }: MainContentProps) {
  switch (activeSection) {
    case 'ask':
      return <ConversationView stream={stream} />;
    case 'sources':
      return <SourcesView stream={stream} />;
    case 'timeline':
      return <TimelineView stream={stream} />;
    case 'subjects':
      return <SubjectsView stream={stream} />;
    case 'agents':
      return <AgentsView stream={stream} />;
    case 'automations':
      return <AutomationsView stream={stream} />;
    default:
      return <ConversationView stream={stream} />;
  }
}