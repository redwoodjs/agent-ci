import { Search, MoreHorizontal, Lock, Users, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { Badge } from './ui/badge';

interface Space {
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

interface SpacesListProps {
  spaces: Space[];
  onSpaceSelect: (space: Space) => void;
}

export function SpacesList({ spaces, onSpaceSelect }: SpacesListProps) {
  return (
    <div className="min-h-screen bg-background">


      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="mb-2">Streams</h1>
            <p className="text-muted-foreground">
              Streams organize your files, pull requests, issues, and standards so AI can give 
              better, more relevant help for your work.
            </p>
          </div>
          <Button className="bg-green-600 hover:bg-green-700">Create space</Button>
        </div>

        {/* Search */}
        <div className="relative mb-8">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            placeholder="Search..." 
            className="pl-10"
          />
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-6 mb-8 border-b">
          <button className="pb-2 border-b-2 border-foreground">
            Yours <Badge variant="secondary" className="ml-2">0</Badge>
          </button>
          <button className="pb-2 text-muted-foreground hover:text-foreground">
            Organizations <Badge variant="secondary" className="ml-2">2</Badge>
          </button>
        </div>

        {/* Spaces List */}
        <div className="space-y-4">
          {spaces.map((space) => (
            <Card 
              key={space.id} 
              className="p-6 hover:bg-accent/50 cursor-pointer transition-colors"
              onClick={() => onSpaceSelect(space)}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3>{space.name}</h3>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <div className="w-4 h-4 bg-muted rounded flex items-center justify-center">
                          <span className="text-xs">G</span>
                        </div>
                        {space.owner}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        {space.privacy === 'Private' ? (
                          <Lock className="w-3 h-3" />
                        ) : (
                          <Users className="w-3 h-3" />
                        )}
                        {space.privacy}
                      </div>
                    </div>
                  </div>
                  {space.description && (
                    <p className="text-muted-foreground text-sm">{space.description}</p>
                  )}
                </div>
                <Button variant="ghost" size="sm">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}