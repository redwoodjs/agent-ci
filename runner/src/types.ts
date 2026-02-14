export interface Job {
  deliveryId: string;
  eventType: string;
  repository?: {
    owner?: {
      login: string;
    };
    name: string;
  };
  env?: Record<string, string>;
  githubJobId?: string | number;
  githubRepo?: string;
  githubToken?: string;
  localSync?: boolean;
  localPath?: string;
  headSha?: string;
  [key: string]: any;
}
