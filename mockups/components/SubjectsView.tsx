import { useState } from 'react';
import { Tag, Search, TrendingUp, Clock, FileText } from 'lucide-react';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';

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

interface SubjectsViewProps {
  stream: Stream;
}

interface Subject {
  id: string;
  name: string;
  description: string;
  eventCount: number;
  sourceCount: number;
  lastActivity: string;
  trend: 'up' | 'down' | 'stable';
  confidence: number;
  relatedFiles: string[];
  topKeywords: string[];
}

const mockSubjects: Subject[] = [
  {
    id: '1',
    name: 'Database Migrations',
    description: 'Schema changes, migration files, and database versioning',
    eventCount: 24,
    sourceCount: 8,
    lastActivity: '2 minutes ago',
    trend: 'up',
    confidence: 92,
    relatedFiles: ['001_initial_setup.ts', '002_add_company_profile.ts', '003_set_defaults.ts'],
    topKeywords: ['migration', 'schema', 'database', 'table']
  },
  {
    id: '2',
    name: 'Query Building',
    description: 'Type-safe SQL queries and query optimization',
    eventCount: 18,
    sourceCount: 12,
    lastActivity: '15 minutes ago',
    trend: 'stable',
    confidence: 88,
    relatedFiles: ['user.queries.ts', 'company.queries.ts', 'utils.ts'],
    topKeywords: ['select', 'join', 'where', 'kysely']
  },
  {
    id: '3',
    name: 'Type Safety',
    description: 'TypeScript types and interfaces for database operations',
    eventCount: 15,
    sourceCount: 6,
    lastActivity: '1 hour ago',
    trend: 'up',
    confidence: 85,
    relatedFiles: ['database.types.ts', 'kysely.config.ts'],
    topKeywords: ['interface', 'type', 'generic', 'typescript']
  },
  {
    id: '4',
    name: 'Error Handling',
    description: 'Database error handling and validation patterns',
    eventCount: 9,
    sourceCount: 4,
    lastActivity: '2 hours ago',
    trend: 'down',
    confidence: 76,
    relatedFiles: ['error.handlers.ts', 'validation.ts'],
    topKeywords: ['error', 'try', 'catch', 'validation']
  },
  {
    id: '5',
    name: 'Testing',
    description: 'Database tests and testing utilities',
    eventCount: 12,
    sourceCount: 7,
    lastActivity: '3 hours ago',
    trend: 'stable',
    confidence: 82,
    relatedFiles: ['db.test.ts', 'migration.test.ts', 'query.test.ts'],
    topKeywords: ['test', 'expect', 'mock', 'jest']
  }
];

export function SubjectsView({ stream }: SubjectsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSubject, setSelectedSubject] = useState<Subject | null>(null);

  const filteredSubjects = mockSubjects.filter(subject =>
    subject.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    subject.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    subject.topKeywords.some(keyword => 
      keyword.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  const getTrendIcon = (trend: 'up' | 'down' | 'stable') => {
    switch (trend) {
      case 'up': return <TrendingUp className="w-3 h-3 text-green-600" />;
      case 'down': return <TrendingUp className="w-3 h-3 text-red-600 transform rotate-180" />;
      default: return <div className="w-3 h-3 bg-gray-400 rounded-full" />;
    }
  };

  return (
    <div className="flex-1 p-6">
      <div className="max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2>Subject Clustering</h2>
            <p className="text-muted-foreground text-sm">
              Auto-generated topic bins based on all stream content and activities
            </p>
          </div>
          <Badge variant="secondary">{filteredSubjects.length} subjects</Badge>
        </div>

        {/* Search */}
        <div className="relative mb-6 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search subjects or keywords..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        <div className="flex gap-6">
          {/* Subjects List */}
          <div className="flex-1 space-y-4">
            {filteredSubjects.map((subject) => (
              <Card 
                key={subject.id} 
                className={`p-4 cursor-pointer transition-colors ${
                  selectedSubject?.id === subject.id ? 'bg-accent' : 'hover:bg-accent/50'
                }`}
                onClick={() => setSelectedSubject(subject)}
              >
                <div className="flex items-start gap-4">
                  <div className="mt-1">
                    <Tag className="w-5 h-5 text-muted-foreground" />
                  </div>
                  
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-medium">{subject.name}</h3>
                      {getTrendIcon(subject.trend)}
                      <Badge variant="outline" className="text-xs">
                        {subject.confidence}% confident
                      </Badge>
                    </div>
                    
                    <p className="text-sm text-muted-foreground mb-3">{subject.description}</p>
                    
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {subject.eventCount} events
                      </div>
                      <div className="flex items-center gap-1">
                        <FileText className="w-3 h-3" />
                        {subject.sourceCount} sources
                      </div>
                      <span>Last: {subject.lastActivity}</span>
                    </div>
                    
                    <div className="flex items-center gap-1 mt-2">
                      {subject.topKeywords.slice(0, 4).map((keyword, index) => (
                        <Badge key={index} variant="secondary" className="text-xs">
                          {keyword}
                        </Badge>
                      ))}
                      {subject.topKeywords.length > 4 && (
                        <span className="text-xs text-muted-foreground">
                          +{subject.topKeywords.length - 4} more
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}

            {filteredSubjects.length === 0 && (
              <div className="text-center py-12">
                <p className="text-muted-foreground">
                  {searchQuery ? 'No subjects match your search.' : 'No subjects detected yet.'}
                </p>
                <p className="text-sm text-muted-foreground mt-2">
                  Add more sources and activity to generate subject clusters.
                </p>
              </div>
            )}
          </div>

          {/* Subject Detail Panel */}
          {selectedSubject && (
            <div className="w-80 space-y-4">
              <Card className="p-4">
                <h3 className="font-medium mb-3">{selectedSubject.name}</h3>
                
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span>Confidence</span>
                      <span>{selectedSubject.confidence}%</span>
                    </div>
                    <Progress value={selectedSubject.confidence} className="h-2" />
                  </div>
                  
                  <div className="text-sm">
                    <span className="text-muted-foreground">Activity:</span>
                    <div className="flex items-center gap-2 mt-1">
                      <span>{selectedSubject.eventCount} events</span>
                      {getTrendIcon(selectedSubject.trend)}
                    </div>
                  </div>
                  
                  <div className="text-sm">
                    <span className="text-muted-foreground">Last activity:</span>
                    <div className="mt-1">{selectedSubject.lastActivity}</div>
                  </div>
                </div>
              </Card>

              <Card className="p-4">
                <h4 className="font-medium mb-3">Related Files</h4>
                <div className="space-y-2">
                  {selectedSubject.relatedFiles.map((file, index) => (
                    <div key={index} className="flex items-center gap-2 text-sm">
                      <FileText className="w-3 h-3 text-muted-foreground" />
                      <span>{file}</span>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="p-4">
                <h4 className="font-medium mb-3">Keywords</h4>
                <div className="flex flex-wrap gap-1">
                  {selectedSubject.topKeywords.map((keyword, index) => (
                    <Badge key={index} variant="secondary" className="text-xs">
                      {keyword}
                    </Badge>
                  ))}
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}