export interface JobStep {
  Id: string;
  name: string;
  [key: string]: any;
}

export interface JobVariable {
  Value: string;
  IsSecret: boolean;
}

export interface ContextDataValue {
  t: number;
  v: any;
}

export interface ContextDataItem {
  k: string;
  v: ContextDataValue;
}

export interface ContextData {
  [key: string]: {
    t: number;
    v: ContextDataItem[];
  };
}

export interface Endpoint {
  Name: string;
  Url: string;
  Authorization: {
    Parameters: {
      AccessToken: string;
    };
    Scheme: string;
  };
}

export interface RepositoryProperties {
  id: string;
  name: string;
  fullName: string;
  repoFullName?: string; // Re-added as required by runner
  owner?: string;
  defaultBranch?: string;
  cloneUrl?: string;
  [key: string]: string | undefined;
}

export interface JobRepository {
  Alias: string;
  Id: string;
  Type: string;
  Version: string;
  Url: string;
  Properties: RepositoryProperties;
  [key: string]: any;
}

export interface JobResources {
  Repositories: JobRepository[];
  Endpoints: Endpoint[];
}

export interface JobWorkspace {
  Path: string;
}

export interface PipelineAgentJobRequest {
  MessageType: 'PipelineAgentJobRequest';
  Plan: {
    PlanId: string;
    PlanType: string;
    ScopeId: string;
  };
  Timeline: {
    Id: string;
    ChangeId: number;
  };
  JobId: string;
  RequestId: number;
  JobDisplayName: string;
  JobName: string;
  Steps: JobStep[];
  Variables: { [key: string]: JobVariable };
  ContextData: ContextData;
  Resources: JobResources;
  Workspace: JobWorkspace;
  SystemVssConnection: {
    Url: string;
    Authorization: {
      Parameters: {
        AccessToken: string;
      };
      Scheme: string;
    };
  };
  Actions: any[];
  MaskHints: any[];
  EnvironmentVariables: any[];
}

export interface MessageResponse {
  MessageId: number;
  MessageType: string;
  Body: string;
}
