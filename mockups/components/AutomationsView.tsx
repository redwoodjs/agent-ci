import { useState } from 'react';
import { Zap, Plus, Settings, Play, Pause, MoreHorizontal, CheckCircle, AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Switch } from './ui/switch';

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

interface AutomationsViewProps {
  stream: Stream;
}

interface Automation {
  id: string;
  name: string;
  description: string;
  trigger: string;
  action: string;
  enabled: boolean;
  lastTriggered: string;
  triggerCount: number;
  successCount: number;
  conditions?: string[];
  agents?: string[];
  recentRuns: {
    timestamp: string;
    status: 'success' | 'error';
    message: string;
  }[];
}

const mockAutomations: Automation[] = [
  {
    id: '1',
    name: 'PR Risk Assessment',
    description: 'Analyze PR changes and assess potential risks based on timeline and subject correlation',
    trigger: 'PR opened',
    action: 'Generate risk summary + timeline analysis',
    enabled: true,
    lastTriggered: '2 hours ago',
    triggerCount: 34,
    successCount: 32,
    conditions: ['PR affects database files', 'Changes > 100 lines'],
    agents: ['Code Reviewer', 'Database Planner'],
    recentRuns: [
      { timestamp: '2 hours ago', status: 'success', message: 'Risk assessment completed for PR #42' },
      { timestamp: '1 day ago', status: 'success', message: 'Low risk PR detected, minimal analysis' },
      { timestamp: '2 days ago', status: 'error', message: 'Failed to access PR diff' }
    ]
  },
  {
    id: '2',
    name: 'Test Failure Auto-Fix',
    description: 'When tests fail, automatically pull related subject bins and attempt fixes',
    trigger: 'Test failure detected',
    action: 'Analyze failure + apply suggested fixes',
    enabled: true,
    lastTriggered: '1 day ago',
    triggerCount: 18,
    successCount: 14,
    conditions: ['Test is in migration category', 'Failure rate < 50%'],
    agents: ['Test Fixer', 'Code Reviewer'],
    recentRuns: [
      { timestamp: '1 day ago', status: 'success', message: 'Fixed migration test timeout' },
      { timestamp: '3 days ago', status: 'success', message: 'Applied database mock fix' },
      { timestamp: '4 days ago', status: 'error', message: 'Complex test failure, manual intervention needed' }
    ]
  },
  {
    id: '3',
    name: 'Documentation Sync',
    description: 'Keep documentation up to date when significant code changes are detected',
    trigger: 'Major code changes committed',
    action: 'Update docs + generate changelog',
    enabled: false,
    lastTriggered: '1 week ago',
    triggerCount: 7,
    successCount: 6,
    conditions: ['Public API changes', 'New features added'],
    agents: ['Research Assistant'],
    recentRuns: [
      { timestamp: '1 week ago', status: 'success', message: 'Updated API documentation' },
      { timestamp: '2 weeks ago', status: 'success', message: 'Generated changelog for v2.1' },
      { timestamp: '3 weeks ago', status: 'error', message: 'Documentation build failed' }
    ]
  },
  {
    id: '4',
    name: 'Security Alert Response',
    description: 'Automatically investigate and respond to security alerts in dependencies',
    trigger: 'Security alert received',
    action: 'Assess impact + create remediation plan',
    enabled: true,
    lastTriggered: '3 days ago',
    triggerCount: 12,
    successCount: 11,
    conditions: ['High severity alert', 'Affects production dependencies'],
    agents: ['Code Reviewer', 'Research Assistant'],
    recentRuns: [
      { timestamp: '3 days ago', status: 'success', message: 'Lodash vulnerability assessed - low impact' },
      { timestamp: '1 week ago', status: 'success', message: 'Updated vulnerable package' },
      { timestamp: '2 weeks ago', status: 'success', message: 'No action needed for dev dependency alert' }
    ]
  }
];

export function AutomationsView({ stream }: AutomationsViewProps) {
  const [automations, setAutomations] = useState<Automation[]>(mockAutomations);
  const [selectedAutomation, setSelectedAutomation] = useState<Automation | null>(null);

  const toggleAutomation = (automationId: string) => {
    setAutomations(automations.map(automation => 
      automation.id === automationId 
        ? { ...automation, enabled: !automation.enabled }
        : automation
    ));
  };

  const getSuccessRate = (automation: Automation) => {
    return automation.triggerCount > 0 
      ? Math.round((automation.successCount / automation.triggerCount) * 100)
      : 0;
  };

  return (
    <div className="flex-1 p-6">
      <div className="max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2>Automations</h2>
            <p className="text-muted-foreground text-sm">
              "When X happens → do Y" workflows powered by your stream context and agents
            </p>
          </div>
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Create Automation
          </Button>
        </div>

        <div className="flex gap-6">
          {/* Automations List */}
          <div className="flex-1 space-y-4">
            {automations.map((automation) => (
              <Card 
                key={automation.id} 
                className={`p-4 cursor-pointer transition-colors ${
                  selectedAutomation?.id === automation.id ? 'bg-accent' : 'hover:bg-accent/50'
                }`}
                onClick={() => setSelectedAutomation(automation)}
              >
                <div className="flex items-start gap-4">
                  <div className="mt-1">
                    <Zap className={`w-5 h-5 ${automation.enabled ? 'text-blue-600' : 'text-muted-foreground'}`} />
                  </div>
                  
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-medium">{automation.name}</h3>
                      <Badge variant={automation.enabled ? 'default' : 'secondary'}>
                        {automation.enabled ? 'Active' : 'Paused'}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {getSuccessRate(automation)}% success
                      </Badge>
                    </div>
                    
                    <p className="text-sm text-muted-foreground mb-3">{automation.description}</p>
                    
                    <div className="flex items-center gap-6 text-xs text-muted-foreground mb-3">
                      <div>
                        <span className="font-medium">Trigger:</span> {automation.trigger}
                      </div>
                      <div>
                        <span className="font-medium">Action:</span> {automation.action}
                      </div>
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>{automation.triggerCount} triggers</span>
                        <span>Last: {automation.lastTriggered}</span>
                        {automation.agents && (
                          <span>{automation.agents.length} agents</span>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={automation.enabled}
                          onCheckedChange={() => toggleAutomation(automation.id)}
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

          {/* Automation Detail Panel */}
          {selectedAutomation && (
            <div className="w-80 space-y-4">
              <Card className="p-4">
                <h3 className="font-medium mb-3">{selectedAutomation.name}</h3>
                
                <div className="space-y-3">
                  <div className="text-sm">
                    <span className="text-muted-foreground">Status:</span>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant={selectedAutomation.enabled ? 'default' : 'secondary'}>
                        {selectedAutomation.enabled ? 'Active' : 'Paused'}
                      </Badge>
                    </div>
                  </div>
                  
                  <div className="text-sm">
                    <span className="text-muted-foreground">Success Rate:</span>
                    <div className="mt-1">{getSuccessRate(selectedAutomation)}% ({selectedAutomation.successCount}/{selectedAutomation.triggerCount})</div>
                  </div>
                  
                  <div className="text-sm">
                    <span className="text-muted-foreground">Last triggered:</span>
                    <div className="mt-1">{selectedAutomation.lastTriggered}</div>
                  </div>
                </div>
              </Card>

              <Card className="p-4">
                <h4 className="font-medium mb-3">Trigger & Action</h4>
                <div className="space-y-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">When:</span>
                    <div className="mt-1 font-medium">{selectedAutomation.trigger}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Then:</span>
                    <div className="mt-1 font-medium">{selectedAutomation.action}</div>
                  </div>
                </div>
              </Card>

              {selectedAutomation.conditions && (
                <Card className="p-4">
                  <h4 className="font-medium mb-3">Conditions</h4>
                  <div className="space-y-1">
                    {selectedAutomation.conditions.map((condition, index) => (
                      <div key={index} className="text-sm flex items-center gap-2">
                        <div className="w-2 h-2 bg-primary rounded-full" />
                        {condition}
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {selectedAutomation.agents && (
                <Card className="p-4">
                  <h4 className="font-medium mb-3">Connected Agents</h4>
                  <div className="space-y-1">
                    {selectedAutomation.agents.map((agent, index) => (
                      <Badge key={index} variant="outline" className="text-xs mr-1 mb-1">
                        {agent}
                      </Badge>
                    ))}
                  </div>
                </Card>
              )}

              <Card className="p-4">
                <h4 className="font-medium mb-3">Recent Runs</h4>
                <div className="space-y-2">
                  {selectedAutomation.recentRuns.map((run, index) => (
                    <div key={index} className="text-xs">
                      <div className="flex items-center gap-2 mb-1">
                        {run.status === 'success' ? (
                          <CheckCircle className="w-3 h-3 text-green-600" />
                        ) : (
                          <AlertTriangle className="w-3 h-3 text-red-600" />
                        )}
                        <span>{run.message}</span>
                      </div>
                      <div className="text-muted-foreground ml-5">{run.timestamp}</div>
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