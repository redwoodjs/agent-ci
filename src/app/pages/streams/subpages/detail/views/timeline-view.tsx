import { Card } from '@/app/components/ui/card';
import { Badge } from '@/app/components/ui/badge';
import { Stream } from '../../../types';
import { Clock } from 'lucide-react';

interface TimelineViewProps {
  stream: Stream;
}

const mockEvents = [
  {
    id: 1,
    type: 'Subject Added',
    title: 'Added "Database Migrations" subject',
    description: 'New subject extracted from latest documentation',
    timestamp: '2 hours ago',
    status: 'success'
  },
  {
    id: 2,
    type: 'Source Sync',
    title: 'GitHub repository synced',
    description: 'Processed 15 new commits and 3 pull requests',
    timestamp: '4 hours ago',
    status: 'success'
  },
  {
    id: 3,
    type: 'Agent Update',
    title: 'Code analysis agent updated',
    description: 'Improved TypeScript inference capabilities',
    timestamp: '1 day ago',
    status: 'info'
  }
];

export function TimelineView({ stream }: TimelineViewProps) {
  return (
    <div className="flex-1 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Timeline</h2>
          <p className="text-muted-foreground">
            Recent activity and updates for {stream.name}.
          </p>
        </div>

        <div className="space-y-4">
          {mockEvents.map((event) => (
            <Card key={event.id} className="p-6">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    event.status === 'success' 
                      ? 'bg-green-100 text-green-600' 
                      : 'bg-blue-100 text-blue-600'
                  }`}>
                    <Clock className="w-4 h-4" />
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-medium">{event.title}</h3>
                    <Badge variant="secondary">{event.type}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">
                    {event.description}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {event.timestamp}
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