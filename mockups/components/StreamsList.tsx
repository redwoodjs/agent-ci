import {
  Search,
  MoreHorizontal,
  Lock,
  Users,
  X,
  Calendar,
  Clock,
  TrendingUp,
  ChevronDown,
  Github,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface Stream {
  id: string;
  name: string;
  description?: string;
  privacy: "Private" | "Shared";
  owner: string;
  coverage: number;
  freshness: "Live" | "Stale" | "Fresh";
  subjects: number;
  agents: number;
  sourceCount: number;
}

interface StreamsListProps {
  streams: Stream[];
  onStreamSelect: (stream: Stream) => void;
}

export function StreamsList({
  streams,
  onStreamSelect,
}: StreamsListProps) {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="mb-2">Streams</h1>
            <p className="text-muted-foreground">
              Streams are knowledge containers that group
              related subjects.
            </p>
          </div>
          <Button className="bg-green-600 hover:bg-green-700">
            Create stream
          </Button>
        </div>

        {/* Search */}
        <div className="relative mb-8">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search..." className="pl-10" />
        </div>

        {/* Two Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-8">
          {/* Left Column - Subjects */}
          <div>
            <div className="space-y-4">
              {streams.map((stream) => (
                <Card
                  key={stream.id}
                  className="p-6 hover:bg-accent/50 cursor-pointer transition-colors"
                  onClick={() => onStreamSelect(stream)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3>
                          {stream.name}
                        </h3>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Github className="w-4 h-4" />
                            {stream.owner}/repo
                          </div>
                        </div>
                      </div>
                      {stream.description && (
                        <p className="text-muted-foreground text-sm mb-4">
                          {stream.description}
                        </p>
                      )}
                      
                      {/* Stats and Timeline */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-6 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <span>{Math.min(stream.sourceCount, 5)} sources</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <span>{stream.subjects} subjects</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>Updated {stream.id === '1' ? '2h ago' : stream.id === '2' ? '15m ago' : '1d ago'}</span>
                          </div>
                        </div>
                        
                        {/* GitHub-style Activity Graph */}
                        <div className="flex items-center gap-2">
                          <div className="grid grid-cols-7 gap-px">
                            {stream.id === '1' ? (
                              <>
                                <div className="w-2 h-2 rounded-sm bg-green-500/40"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500/60"></div>
                                <div className="w-2 h-2 rounded-sm bg-muted"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500/80"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500/20"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500/60"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500"></div>
                              </>
                            ) : stream.id === '2' ? (
                              <>
                                <div className="w-2 h-2 rounded-sm bg-green-500/80"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500/60"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500/80"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500"></div>
                              </>
                            ) : (
                              <>
                                <div className="w-2 h-2 rounded-sm bg-muted"></div>
                                <div className="w-2 h-2 rounded-sm bg-muted"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500/20"></div>
                                <div className="w-2 h-2 rounded-sm bg-muted"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500/40"></div>
                                <div className="w-2 h-2 rounded-sm bg-muted"></div>
                                <div className="w-2 h-2 rounded-sm bg-green-500/20"></div>
                              </>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {stream.id === '1' ? '12 events this week' : 
                             stream.id === '2' ? '31 events this week' : 
                             '3 events this week'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm">
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          {/* Right Column - Discovered Subjects */}
          <div className="space-y-8">
            {/* Discovered Subjects Section */}
          </div>
        </div>
      </div>
    </div>
  );
}