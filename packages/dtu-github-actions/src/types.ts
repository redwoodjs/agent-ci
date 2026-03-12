export interface JobStep {
  Id: string;
  Name: string;
  Type: string;
  Reference: {
    Type: string;
    [key: string]: any;
  };
  Inputs?: { [key: string]: string };
  ContextData?: any;
  [key: string]: any;
}

export interface JobVariable {
  Value: string;
  IsSecret: boolean;
}

export interface ContextDataValue {
  t: number;
  s?: string;
  b?: boolean;
  n?: number;
  a?: ContextDataValue[];
  d?: ContextDataItem[];
  v?: any; // Re-add v for fallback
}

export interface ContextDataItem {
  k: string;
  v: ContextDataValue;
}

export interface ContextData {
  [key: string]: ContextDataValue;
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
  MessageType: "PipelineAgentJobRequest";
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
  // JobContainer is a TemplateToken (MappingToken) when present — opaque at the type level.
  // The runner deserializes it via TemplateTokenJsonConverter.EvaluateJobContainer().
  JobContainer?: object;
}

export interface MessageResponse {
  MessageId: number;
  MessageType: string;
  Body: string;
}
