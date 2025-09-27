import { useState } from 'react';
import { Clock, FileText, GitCommit, GitBranch, Video, Terminal, Globe, Filter } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

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

interface TimelineViewProps {
  stream: Stream;
}

interface TimelineEvent {
  id: string;
  type: 'file_read' | 'file_write' | 'command' | 'commit' | 'branch_switch' | 'page_reload' | 'meeting';
  timestamp: string;
  description: string;
  details?: string;
  subject?: string;
  actor: string;
  source?: string;
}

const mockEvents: TimelineEvent[] = [
  {
    id: '1',
    type: 'file_write',
    timestamp: '2 minutes ago',
    description: 'Modified kysely.config.ts',
    details: 'Updated database connection settings',
    subject: 'Database Configuration',
    actor: 'VS Code',
    source: 'kysely.config.ts'
  },
  {
    id: '2',
    type: 'command',
    timestamp: '5 minutes ago',
    description: 'npm run test',
    details: 'All tests passed (24 suites, 156 tests)',
    subject: 'Testing',
    actor: 'Terminal',
  },
  {
    id: '3',
    type: 'commit',
    timestamp: '12 minutes ago',
    description: 'feat: add user table migration',
    details: 'Added new migration file for user table with proper indexes',
    subject: 'Database Migrations',
    actor: 'Git',
  },
  {
    id: '4',
    type: 'file_read',
    timestamp: '18 minutes ago',
    description: 'Opened 003_set_text_id_defaults.ts',
    subject: 'Database Migrations',
    actor: 'VS Code',
    source: '003_set_text_id_defaults.ts'
  },
  {
    id: '5',
    type: 'branch_switch',
    timestamp: '25 minutes ago',
    description: 'Switched to feature/user-auth',
    subject: 'Version Control',
    actor: 'Git',
  },
  {
    id: '6',
    type: 'meeting',
    timestamp: '1 hour ago',
    description: 'Architecture Review Meeting',
    details: 'Discussed database schema changes and migration strategy',
    subject: 'Architecture',
    actor: 'Meeting',
  },
  {
    id: '7',
    type: 'page_reload',
    timestamp: '1 hour ago',
    description: 'Localhost:3000 reloaded',
    subject: 'Development',
    actor: 'Browser',
  }
];

const eventIcons = {
  file_read: FileText,
  file_write: FileText,
  command: Terminal,
  commit: GitCommit,
  branch_switch: GitBranch,
  page_reload: Globe,
  meeting: Video
};

const eventColors = {
  file_read: 'text-blue-600',
  file_write: 'text-green-600',
  command: 'text-purple-600',
  commit: 'text-orange-600',
  branch_switch: 'text-pink-600',
  page_reload: 'text-cyan-600',
  meeting: 'text-indigo-600'
};

export function TimelineView({ stream }: TimelineViewProps) {
  const [filterSubject, setFilterSubject] = useState<string>('all');
  const [filterEventType, setFilterEventType] = useState<string>('all');
  const [filterActor, setFilterActor] = useState<string>('all');

  const subjects = Array.from(new Set(mockEvents.map(event => event.subject).filter(Boolean)));
  const eventTypes = Array.from(new Set(mockEvents.map(event => event.type)));
  const actors = Array.from(new Set(mockEvents.map(event => event.actor)));

  const filteredEvents = mockEvents.filter(event => {
    if (filterSubject !== 'all' && event.subject !== filterSubject) return false;
    if (filterEventType !== 'all' && event.type !== filterEventType) return false;
    if (filterActor !== 'all' && event.actor !== filterActor) return false;
    return true;
  });

  return (
    <div className="flex-1 p-6">
      <div className="max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2>Workstream Timeline</h2>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{filteredEvents.length} events</Badge>
            <Button variant="outline" size="sm">
              <Filter className="w-4 h-4 mr-2" />
              Export
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 mb-6">
          <Select value={filterSubject} onValueChange={setFilterSubject}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Filter by subject" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Subjects</SelectItem>
              {subjects.map(subject => (
                <SelectItem key={subject} value={subject!}>{subject}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={filterEventType} onValueChange={setFilterEventType}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Filter by event type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Event Types</SelectItem>
              {eventTypes.map(type => (
                <SelectItem key={type} value={type}>
                  {type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={filterActor} onValueChange={setFilterActor}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Filter by actor" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actors</SelectItem>
              {actors.map(actor => (
                <SelectItem key={actor} value={actor}>{actor}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Timeline */}
        <div className="space-y-4">
          {filteredEvents.map((event, index) => {
            const Icon = eventIcons[event.type];
            const colorClass = eventColors[event.type];
            
            return (
              <Card key={event.id} className="p-4">
                <div className="flex items-start gap-4">
                  <div className={`mt-1 ${colorClass}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <h4 className="font-medium">{event.description}</h4>
                      <div className="flex items-center gap-2">
                        <Clock className="w-3 h-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">{event.timestamp}</span>
                      </div>
                    </div>
                    
                    {event.details && (
                      <p className="text-sm text-muted-foreground mb-2">{event.details}</p>
                    )}
                    
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">{event.actor}</Badge>
                      {event.subject && (
                        <Badge variant="secondary" className="text-xs">{event.subject}</Badge>
                      )}
                      {event.source && (
                        <Badge variant="outline" className="text-xs">{event.source}</Badge>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>

        {filteredEvents.length === 0 && (
          <div className="text-center py-12">
            <p className="text-muted-foreground">No events match your current filters.</p>
          </div>
        )}
      </div>
    </div>
  );
}