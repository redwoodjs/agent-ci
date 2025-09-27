import { Card } from '@/app/components/ui/card';
import { Badge } from '@/app/components/ui/badge';
import { Stream } from '../../../types';
import { Tag } from 'lucide-react';

interface SubjectsViewProps {
  stream: Stream;
}

const mockSubjects = [
  {
    id: 1,
    name: 'TypeScript Integration',
    description: 'Type-safe SQL query building with TypeScript',
    confidence: 0.95,
    sources: 8,
    lastUpdated: '2h ago'
  },
  {
    id: 2,
    name: 'Database Migrations',
    description: 'Schema versioning and database migration patterns',
    confidence: 0.88,
    sources: 12,
    lastUpdated: '1d ago'
  },
  {
    id: 3,
    name: 'Query Performance',
    description: 'Optimization techniques for SQL queries',
    confidence: 0.82,
    sources: 6,
    lastUpdated: '3d ago'
  },
  {
    id: 4,
    name: 'Connection Pooling',
    description: 'Database connection management and pooling',
    confidence: 0.77,
    sources: 4,
    lastUpdated: '1w ago'
  }
];

export function SubjectsView({ stream }: SubjectsViewProps) {
  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.9) return 'bg-green-100 text-green-800';
    if (confidence >= 0.8) return 'bg-blue-100 text-blue-800';
    return 'bg-yellow-100 text-yellow-800';
  };

  return (
    <div className="flex-1 p-6 bg-white">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Subjects</h2>
          <p className="text-muted-foreground">
            Key topics and concepts extracted from {stream.name}'s knowledge base.
          </p>
        </div>

        <div className="grid gap-4">
          {mockSubjects.map((subject) => (
            <Card key={subject.id} className="p-6 bg-white border border-gray-200">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <Tag className="w-4 h-4 text-muted-foreground" />
                    <h3 className="font-medium">{subject.name}</h3>
                    <Badge 
                      className={getConfidenceColor(subject.confidence)}
                    >
                      {Math.round(subject.confidence * 100)}% confidence
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">
                    {subject.description}
                  </p>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>{subject.sources} sources</span>
                    <span>Updated {subject.lastUpdated}</span>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}