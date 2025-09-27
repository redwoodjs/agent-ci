import { useState } from 'react';
import { Plus, MessageSquare, Github, Video, BookOpen, Trello, GitPullRequest, Terminal, Bot, Trash2, Search, Filter } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Checkbox } from './ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

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

interface SourcesViewProps {
  stream: Stream;
}

interface Source {
  id: string;
  name: string;
  type: 'chat' | 'forum' | 'conversation' | 'knowledge' | 'project' | 'pullrequest' | 'machine' | 'agent';
  service: string;
  status: 'Connected' | 'Disconnected' | 'Error';
  lastUpdate: string;
  selected: boolean;
  channels?: string[];
}

const mockSources: Source[] = [
  {
    id: '1',
    name: 'Development Team Workspace',
    type: 'chat',
    service: 'Slack',
    status: 'Connected',
    lastUpdate: '2 minutes ago',
    selected: false,
    channels: ['#general', '#dev', '#product', '#random']
  },
  {
    id: '2',
    name: 'redwoodjs/sdk',
    type: 'forum',
    service: 'GitHub Discussions',
    status: 'Connected',
    lastUpdate: '1 hour ago',
    selected: false
  },
  {
    id: '3',
    name: 'Weekly standup',
    type: 'conversation',
    service: 'Zoom',
    status: 'Connected',
    lastUpdate: '2 days ago',
    selected: false
  },
  {
    id: '4',
    name: 'Engineering Wiki',
    type: 'knowledge',
    service: 'Notion',
    status: 'Connected',
    lastUpdate: '3 hours ago',
    selected: false
  },
  {
    id: '5',
    name: 'Backend Sprint',
    type: 'project',
    service: 'Linear',
    status: 'Connected',
    lastUpdate: '15 minutes ago',
    selected: false
  },
  {
    id: '6',
    name: 'feat: add query validation',
    type: 'pullrequest',
    service: 'GitHub',
    status: 'Connected',
    lastUpdate: '30 minutes ago',
    selected: false
  },
  {
    id: '7',
    name: 'Local Development',
    type: 'machine',
    service: 'Machinen',
    status: 'Connected',
    lastUpdate: '5 minutes ago',
    selected: false
  },
  {
    id: '8',
    name: 'CodeGen Assistant',
    type: 'agent',
    service: 'Claude Code',
    status: 'Connected',
    lastUpdate: '1 hour ago',
    selected: false
  }
];

export function SourcesView({ stream }: SourcesViewProps) {
  const [sources, setSources] = useState<Source[]>(mockSources);
  const [searchQuery, setSearchQuery] = useState('');
  const [showConversations, setShowConversations] = useState(false);

  const toggleSourceSelection = (sourceId: string) => {
    setSources(sources.map(source => 
      source.id === sourceId 
        ? { ...source, selected: !source.selected }
        : source
    ));
  };

  const toggleSelectAll = () => {
    const allSelected = sources.every(source => source.selected);
    setSources(sources.map(source => ({ ...source, selected: !allSelected })));
  };

  const selectedCount = sources.filter(source => source.selected).length;
  const filteredSources = sources.filter(source =>
    source.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    source.service.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getSourceIcon = (type: string) => {
    switch (type) {
      case 'chat': return MessageSquare;
      case 'forum': return Github;
      case 'conversation': return Video;
      case 'knowledge': return BookOpen;
      case 'project': return Trello;
      case 'pullrequest': return GitPullRequest;
      case 'machine': return Terminal;
      case 'agent': return Bot;
      default: return MessageSquare;
    }
  };

  return (
    <div className="flex-1 p-6">
      <div className="max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-4">
              <button 
                className={`pb-2 ${!showConversations ? 'border-b-2 border-foreground' : 'text-muted-foreground'}`}
                onClick={() => setShowConversations(false)}
              >
                Sources <Badge variant="secondary" className="ml-2">{stream.sourceCount}</Badge>
              </button>

            </div>
          </div>
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Connect sources
          </Button>
        </div>

        {!showConversations ? (
          <>
            {/* Search and Actions */}
            <div className="flex items-center gap-4 mb-6">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search sources..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Button variant="outline" size="sm">
                <Filter className="w-4 h-4 mr-2" />
                Filter
              </Button>
              {selectedCount > 0 && (
                <Button variant="outline" size="sm">
                  <Trash2 className="w-4 h-4 mr-2" />
                  Disconnect ({selectedCount})
                </Button>
              )}
            </div>

            {/* Sources Table */}
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">
                      
                    </TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Update</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSources.map((source) => {
                    const IconComponent = getSourceIcon(source.type);
                    return (
                      <TableRow key={source.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <IconComponent className="w-4 h-4 text-muted-foreground" />
                            <div>
                              <div className="font-medium">{source.name}</div>
                              <div className="text-sm text-muted-foreground">
                                {source.service}
                                {source.channels && (
                                  <div className="mt-1">
                                    {source.channels.slice(0, 3).join(', ')}
                                    {source.channels.length > 3 && ` +${source.channels.length - 3} more`}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge 
                            variant={source.status === 'Connected' ? 'default' : source.status === 'Error' ? 'destructive' : 'secondary'}
                            className="text-xs"
                          >
                            {source.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {source.lastUpdate}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" title="Disconnect source">
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {filteredSources.length === 0 && (
              <div className="text-center py-12">
                <p className="text-muted-foreground">
                  {searchQuery ? 'No sources match your search.' : 'No sources connected yet.'}
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-12">
            <p className="text-muted-foreground">No conversations yet.</p>
            <p className="text-sm text-muted-foreground mt-2">
              Start a conversation in the Ask section to see it here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}