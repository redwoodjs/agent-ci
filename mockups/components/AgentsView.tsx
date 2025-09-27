import { useState } from 'react';
import { Bot, Plus, Settings, Play, Pause, MoreHorizontal, CheckCircle, AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Switch } from './ui/switch';
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

interface AgentsViewProps {
  stream: Stream;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  description: string;
  status: 'active' | 'paused' | 'error';
  enabled: boolean;
  lastRun: string;
  successRate: number;
  totalRuns: number;
  tools: string[];
  triggers: string[];
  recentActions: {
    action: string;
    timestamp: string;
    status: 'success' | 'error';
  }[];
}

const mockAgents: Agent[] = [
  {
    id: '1',
    name: 'Code Reviewer',
    role: 'Reviewer',
    description: 'Reviews code changes for best practices, security issues, and performance optimization',
    status: 'active',
    enabled: true,
    lastRun: '5 minutes ago',
    successRate: 94,
    totalRuns: 127,
    tools: ['Static Analysis', 'Security Scanner', 'Performance Profiler'],
    triggers: ['PR opened', 'Code pushed'],
    recentActions: [
      { action: 'Reviewed PR #42', timestamp: '5 minutes ago', status: 'success' },
      { action: 'Security scan on auth.ts', timestamp: '1 hour ago', status: 'success' },
      { action: 'Performance check failed', timestamp: '2 hours ago', status: 'error' }
    ]
  },
  {
    id: '2',
    name: 'Database Planner',
    role: 'Planner',
    description: 'Plans database migrations and suggests schema optimizations based on usage patterns',
    status: 'active',
    enabled: true,
    lastRun: '2 hours ago',
    successRate: 88,
    totalRuns: 43,
    tools: ['Migration Analyzer', 'Schema Validator', 'Query Optimizer'],
    triggers: ['Schema change detected', 'Migration file added'],
    recentActions: [
      { action: 'Analyzed migration 004', timestamp: '2 hours ago', status: 'success' },
      { action: 'Schema validation', timestamp: '4 hours ago', status: 'success' },
      { action: 'Migration plan generated', timestamp: '6 hours ago', status: 'success' }
    ]
  },
  {
    id: '3',
    name: 'Test Fixer',
    role: 'Fixer',
    description: 'Automatically fixes failing tests and suggests test improvements',
    status: 'paused',
    enabled: false,
    lastRun: '1 day ago',
    successRate: 76,
    totalRuns: 89,
    tools: ['Test Runner', 'Coverage Analyzer', 'Mock Generator'],
    triggers: ['Test failure', 'Coverage drop'],
    recentActions: [
      { action: 'Fixed migration test', timestamp: '1 day ago', status: 'success' },
      { action: 'Coverage analysis', timestamp: '1 day ago', status: 'success' },
      { action: 'Mock generation failed', timestamp: '2 days ago', status: 'error' }
    ]
  },
  {
    id: '4',
    name: 'Research Assistant',
    role: 'Researcher',
    description: 'Researches best practices and latest updates for technologies used in the project',
    status: 'active',
    enabled: true,
    lastRun: '30 minutes ago',
    successRate: 92,
    totalRuns: 156,
    tools: ['Documentation Scanner', 'API Monitor', 'Changelog Tracker'],
    triggers: ['New dependency added', 'Weekly research cycle'],
    recentActions: [
      { action: 'Kysely v0.27 update found', timestamp: '30 minutes ago', status: 'success' },
      { action: 'Security advisory check', timestamp: '2 hours ago', status: 'success' },
      { action: 'Documentation scan', timestamp: '4 hours ago', status: 'success' }
    ]
  }
];

export function AgentsView({ stream }: AgentsViewProps) {
  const [agents, setAgents] = useState<Agent[]>(mockAgents);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  const toggleAgent = (agentId: string) => {
    setAgents(agents.map(agent => 
      agent.id === agentId 
        ? { ...agent, enabled: !agent.enabled, status: agent.enabled ? 'paused' : 'active' }
        : agent
    ));
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-green-100 text-green-800';
      case 'paused': return 'bg-yellow-100 text-yellow-800';
      case 'error': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'active': return <CheckCircle className="w-3 h-3" />;
      case 'paused': return <Pause className="w-3 h-3" />;
      case 'error': return <AlertCircle className="w-3 h-3" />;
      default: return null;
    }
  };

  return (
    <div className="flex-1 p-6">
      <div className="max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2>AI Agents</h2>
            <p className="text-muted-foreground text-sm">
              Autonomous agents with specialized roles and tools for your development workflow
            </p>
          </div>
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Create Agent
          </Button>
        </div>

        <div className="flex gap-6">
          {/* Agents List */}
          <div className="flex-1 space-y-4">
            {agents.map((agent) => (
              <Card 
                key={agent.id} 
                className={`p-4 cursor-pointer transition-colors ${
                  selectedAgent?.id === agent.id ? 'bg-accent' : 'hover:bg-accent/50'
                }`}
                onClick={() => setSelectedAgent(agent)}
              >
                <div className="flex items-start gap-4">
                  <div className="mt-1">
                    <Bot className="w-5 h-5 text-muted-foreground" />
                  </div>
                  
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-medium">{agent.name}</h3>
                      <Badge variant="outline" className="text-xs">{agent.role}</Badge>
                      <Badge className={getStatusColor(agent.status)}>
                        <div className="flex items-center gap-1">
                          {getStatusIcon(agent.status)}
                          {agent.status}
                        </div>
                      </Badge>
                    </div>
                    
                    <p className="text-sm text-muted-foreground mb-3">{agent.description}</p>
                    
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>{agent.successRate}% success rate</span>
                        <span>{agent.totalRuns} total runs</span>
                        <span>Last: {agent.lastRun}</span>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={agent.enabled}
                          onCheckedChange={() => toggleAgent(agent.id)}
                        />
                        <Button variant="ghost" size="sm">
                          <Settings className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Agent Detail Panel */}
          {selectedAgent && (
            <div className="w-80 space-y-4">
              <Card className="p-4">
                <div className="flex items-center gap-3 mb-3">
                  <h3 className="font-medium">{selectedAgent.name}</h3>
                  <Badge variant="outline" className="text-xs">{selectedAgent.role}</Badge>
                </div>
                
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span>Success Rate</span>
                      <span>{selectedAgent.successRate}%</span>
                    </div>
                    <Progress value={selectedAgent.successRate} className="h-2" />
                  </div>
                  
                  <div className="text-sm">
                    <span className="text-muted-foreground">Status:</span>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge className={getStatusColor(selectedAgent.status)}>
                        <div className="flex items-center gap-1">
                          {getStatusIcon(selectedAgent.status)}
                          {selectedAgent.status}
                        </div>
                      </Badge>
                    </div>
                  </div>
                  
                  <div className="text-sm">
                    <span className="text-muted-foreground">Last run:</span>
                    <div className="mt-1">{selectedAgent.lastRun}</div>
                  </div>
                  
                  <div className="text-sm">
                    <span className="text-muted-foreground">Total runs:</span>
                    <div className="mt-1">{selectedAgent.totalRuns}</div>
                  </div>
                </div>
              </Card>

              <Card className="p-4">
                <h4 className="font-medium mb-3">Tools</h4>
                <div className="space-y-1">
                  {selectedAgent.tools.map((tool, index) => (
                    <Badge key={index} variant="secondary" className="text-xs mr-1 mb-1">
                      {tool}
                    </Badge>
                  ))}
                </div>
              </Card>

              <Card className="p-4">
                <h4 className="font-medium mb-3">Triggers</h4>
                <div className="space-y-1">
                  {selectedAgent.triggers.map((trigger, index) => (
                    <div key={index} className="text-sm flex items-center gap-2">
                      <div className="w-2 h-2 bg-primary rounded-full" />
                      {trigger}
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="p-4">
                <h4 className="font-medium mb-3">Recent Actions</h4>
                <div className="space-y-2">
                  {selectedAgent.recentActions.map((action, index) => (
                    <div key={index} className="text-xs">
                      <div className="flex items-center gap-2 mb-1">
                        {action.status === 'success' ? (
                          <CheckCircle className="w-3 h-3 text-green-600" />
                        ) : (
                          <AlertCircle className="w-3 h-3 text-red-600" />
                        )}
                        <span>{action.action}</span>
                      </div>
                      <div className="text-muted-foreground ml-5">{action.timestamp}</div>
                    </div>
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