import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Clock, FileText, GitPullRequest } from 'lucide-react';

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

interface ConversationViewProps {
  stream: Stream;
}

const mockConversations = [
  {
    id: '1',
    question: 'How do I create a type-safe join query with Kysely?',
    answer: 'To create a type-safe join query with Kysely, you can use the `innerJoin`, `leftJoin`, or `rightJoin` methods. Here\'s an example...',
    timestamp: '2 hours ago',
    sources: ['kysely-docs', 'migration-001']
  },
  {
    id: '2',
    question: 'What are the best practices for handling migrations?',
    answer: 'When handling migrations in Kysely, follow these best practices: 1. Always use transactions, 2. Test migrations thoroughly...',
    timestamp: '1 day ago',
    sources: ['migration-guide', 'best-practices']
  }
];

const contextItems = [
  { type: 'subject', name: 'Query Building', count: 15 },
  { type: 'subject', name: 'Type Safety', count: 8 },
  { type: 'subject', name: 'Migrations', count: 12 },
  { type: 'file', name: 'kysely.config.ts', recent: true },
  { type: 'file', name: 'database.types.ts', recent: true },
  { type: 'pr', name: 'Add user table migration', status: 'open' }
];

export function ConversationView({ stream }: ConversationViewProps) {
  return (
    <div className="flex-1 flex">
      {/* Main Conversation */}
      <div className="flex-1 p-6">
        <div className="max-w-4xl">
          {mockConversations.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground mb-4">
                Start a conversation to get AI assistance tailored to your stream context.
              </p>
              <div className="text-sm text-muted-foreground">
                Try asking: "How do I optimize my database queries?" or "Show me migration examples"
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {mockConversations.map((conversation) => (
                <div key={conversation.id} className="space-y-4">
                  <Card className="p-4">
                    <div className="mb-2">
                      <h4 className="font-medium">{conversation.question}</h4>
                      <div className="flex items-center gap-2 mt-1">
                        <Clock className="w-3 h-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">{conversation.timestamp}</span>
                      </div>
                    </div>
                  </Card>
                  
                  <Card className="p-4 bg-muted/30">
                    <p className="text-sm mb-3">{conversation.answer}</p>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Sources:</span>
                      {conversation.sources.map((source, index) => (
                        <Badge key={index} variant="outline" className="text-xs">
                          {source}
                        </Badge>
                      ))}
                    </div>
                  </Card>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Context Summary Panel */}
      <div className="w-80 border-l p-4">
        <h3 className="font-medium mb-4">Active Context</h3>
        
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium mb-2">Top Subjects</h4>
            <div className="space-y-1">
              {contextItems.filter(item => item.type === 'subject').map((subject, index) => (
                <div key={index} className="flex items-center justify-between text-sm">
                  <span>{subject.name}</span>
                  <Badge variant="secondary" className="text-xs">{subject.count}</Badge>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-sm font-medium mb-2">Recent Files</h4>
            <div className="space-y-1">
              {contextItems.filter(item => item.type === 'file').map((file, index) => (
                <div key={index} className="flex items-center gap-2 text-sm">
                  <FileText className="w-3 h-3 text-muted-foreground" />
                  <span>{file.name}</span>
                  {file.recent && <Badge variant="outline" className="text-xs">Recent</Badge>}
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-sm font-medium mb-2">Live PRs</h4>
            <div className="space-y-1">
              {contextItems.filter(item => item.type === 'pr').map((pr, index) => (
                <div key={index} className="flex items-center gap-2 text-sm">
                  <GitPullRequest className="w-3 h-3 text-green-600" />
                  <span>{pr.name}</span>
                  <Badge variant="outline" className="text-xs">{pr.status}</Badge>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}