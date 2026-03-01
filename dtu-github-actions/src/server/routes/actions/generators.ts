import crypto from "node:crypto";
import {
  MessageResponse,
  JobStep,
  JobVariable,
  ContextData,
  PipelineAgentJobRequest,
} from "../../../types.js";

// Helper to convert JS objects to ContextData
export function toContextData(obj: any): any {
  if (typeof obj === "string") {
    return { t: 0, s: obj };
  }
  if (typeof obj === "boolean") {
    return { t: 3, b: obj };
  }
  if (typeof obj === "number") {
    return { t: 4, n: obj };
  }

  if (Array.isArray(obj)) {
    return {
      t: 1,
      a: obj.map(toContextData),
    };
  }

  if (typeof obj === "object" && obj !== null) {
    return {
      t: 2,
      d: Object.entries(obj).map(([k, v]) => ({ k, v: toContextData(v) })),
    };
  }

  // Handle null or undefined
  return { t: 0, s: "" };
}

// Build a TemplateToken MappingToken in the format ActionStep.Inputs expects.
// TemplateTokenJsonConverter uses "type" key (integer) NOT the contextData "t" key.
// TokenType.Mapping = 2. Items are serialized as {Key: scalarToken, Value: templateToken}.
// Strings without file/line/col are serialized as bare string values.
export function toTemplateTokenMapping(obj: { [key: string]: string }): object {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return { type: 2 };
  }
  return {
    type: 2,
    map: entries.map(([k, v]) => ({ Key: k, Value: v })),
  };
}

export function createJobResponse(
  jobId: string,
  payload: any,
  baseUrl: string,
  planId: string,
): MessageResponse {
  const mappedSteps: JobStep[] = (payload.steps || []).map((step: any, index: number) => {
    const inputsObj: { [key: string]: string } =
      step.Inputs || (step.run ? { script: step.run } : {});
    const s = {
      id: step.Id || step.id || crypto.randomUUID(),
      name: step.Name || step.DisplayName || step.name || `step-${index}`,
      type: (step.Type || "Action").toLowerCase(),
      reference: (() => {
        const refTypeSource = step.Reference?.Type || "Script";
        const refTypeString = refTypeSource.toLowerCase();
        let typeInt = 3;
        if (refTypeString === "repository") {
          typeInt = 1;
        } else if (refTypeString === "container") {
          typeInt = 2;
        }

        const reference: any = { type: typeInt };
        if (typeInt === 1 && step.Reference) {
          reference.name = step.Reference.Name;
          reference.ref = step.Reference.Ref;
          reference.repositoryType = step.Reference.RepositoryType || "GitHub";
          reference.path = step.Reference.Path || "";
        }
        return reference;
      })(),
      // inputs is TemplateToken (MappingToken). Must use {"type": 2, "map": [...]} format.
      inputs: toTemplateTokenMapping(inputsObj),
      contextData: step.ContextData || toContextData({}),
      // condition must be explicit — null Condition causes NullReferenceException in EvaluateStepIf
      condition: step.condition || "success()",
    };

    return s;
  });

  const repoFullName = payload.repository?.full_name || "redwoodjs/opposite-actions";
  const ownerName = payload.repository?.owner?.login || "redwoodjs";

  const Variables: { [key: string]: JobVariable } = {
    "system.github.token": { Value: "fake-token", IsSecret: true },
    "system.github.job": { Value: "local-job", IsSecret: false },
    "system.github.repository": { Value: repoFullName, IsSecret: false },
    "github.repository": { Value: repoFullName, IsSecret: false },
    "github.actor": { Value: ownerName, IsSecret: false },
    "github.sha": {
      Value: payload.headSha || "0000000000000000000000000000000000000000",
      IsSecret: false,
    },
    "github.ref": { Value: "refs/heads/main", IsSecret: false },
    repository: { Value: repoFullName, IsSecret: false },
    GITHUB_REPOSITORY: { Value: repoFullName, IsSecret: false },
    GITHUB_ACTOR: { Value: ownerName, IsSecret: false },
    "build.repository.name": { Value: repoFullName, IsSecret: false },
    "build.repository.uri": { Value: `https://github.com/${repoFullName}`, IsSecret: false },
  };

  const githubContext: any = {
    repository: repoFullName,
    actor: ownerName,
    sha: "0000000000000000000000000000000000000000",
    ref: "refs/heads/main",
    server_url: baseUrl,
    api_url: `${baseUrl}/_apis`,
    graphql_url: `${baseUrl}/_graphql`,
    workspace: "/home/runner/_work/opposite-actions/opposite-actions",
    action: "__run",
    token: "fake-token",
    job: "local-job",
  };

  if (payload.pull_request) {
    githubContext.event = {
      pull_request: payload.pull_request,
    };
  } else {
    githubContext.event = {
      repository: {
        full_name: repoFullName,
        name: payload.repository?.name || "opposite-actions",
        owner: { login: ownerName },
      },
    };
  }

  const ContextData: ContextData = {
    github: toContextData(githubContext),
    steps: { t: 2, d: [] }, // Empty steps context (required by EvaluateStepIf)
    needs: { t: 2, d: [] }, // Empty needs context
    strategy: { t: 2, d: [] }, // Empty strategy context
    matrix: { t: 2, d: [] }, // Empty matrix context
  };

  const jobRequest: PipelineAgentJobRequest = {
    MessageType: "PipelineAgentJobRequest",
    Plan: {
      PlanId: planId,
      PlanType: "Action",
      ScopeId: crypto.randomUUID(),
    },
    Timeline: {
      Id: crypto.randomUUID(),
      ChangeId: 1,
    },
    JobId: crypto.randomUUID(),
    RequestId: parseInt(jobId) || 1,
    JobDisplayName: payload.name || "local-job",
    JobName: payload.name || "local-job",
    Steps: mappedSteps,
    Variables: Variables,
    ContextData: ContextData,
    Resources: {
      Repositories: [
        {
          Alias: "self",
          Id: "repo-1",
          Type: "git",
          Version: payload.headSha || "HEAD",
          Url: `https://github.com/${repoFullName}`,
          Properties: {
            id: "repo-1",
            name: payload.repository?.name || "opposite-actions",
            fullName: repoFullName, // Required by types
            repoFullName: repoFullName, // camelCase
            owner: ownerName,
            defaultBranch: payload.repository?.default_branch || "main",
            cloneUrl: `https://github.com/${repoFullName}.git`,
          },
        },
      ],
      Endpoints: [
        {
          Name: "SystemVssConnection",
          Url: baseUrl,
          Authorization: {
            Parameters: {
              AccessToken:
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmNoaWQiOiIxMjMifQ.c2lnbmF0dXJl",
            },
            Scheme: "OAuth",
          },
        },
      ],
    },
    Workspace: {
      Path: "/home/runner/_work/opposite-actions/opposite-actions",
    },
    SystemVssConnection: {
      Url: baseUrl,
      Authorization: {
        Parameters: {
          AccessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmNoaWQiOiIxMjMifQ.c2lnbmF0dXJl",
        },
        Scheme: "OAuth",
      },
    },
    Actions: [],
    MaskHints: [],
    EnvironmentVariables: [],
  };

  return {
    MessageId: 1,
    MessageType: "PipelineAgentJobRequest",
    Body: JSON.stringify(jobRequest),
  };
}
