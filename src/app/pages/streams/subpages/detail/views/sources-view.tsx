import { Card } from '@/app/components/ui/card';
import { Badge } from '@/app/components/ui/badge';
import { Stream } from '../../../types';

interface SourcesViewProps {
  stream: Stream;
}

const mockSources = [
  {
    id: 1,
    type: 'GitHub Repository',
    name: 'kysely/kysely',
    description: 'TypeScript SQL query builder',
    lastSync: '2h ago',
    status: 'Active'
  },
  {
    id: 2,
    type: 'Documentation',
    name: 'Official Kysely Docs',
    description: 'API reference and guides',
    lastSync: '1d ago',
    status: 'Active'
  },
  {
    id: 3,
    type: 'GitHub Issues',
    name: 'Issue Tracker',
    description: 'Bug reports and feature requests',
    lastSync: '6h ago',
    status: 'Active'
  }
];

export function SourcesView({ stream }: SourcesViewProps) {
  return (
    <div className="flex-1 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Sources</h2>
          <p className="text-muted-foreground">
            Data sources that power this stream's knowledge base.
          </p>
        </div>

        <div className="grid gap-4">
          {mockSources.map((source) => (
            <Card key={source.id} className="p-6">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-medium">{source.name}</h3>
                    <Badge variant="secondary">{source.type}</Badge>
                    <Badge 
                      variant={source.status === 'Active' ? 'default' : 'secondary'}
                      className="bg-green-100 text-green-800"
                    >
                      {source.status}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">
                    {source.description}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Last synced: {source.lastSync}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}