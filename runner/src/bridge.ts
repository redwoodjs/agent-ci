import { config } from "./config";
import { Job } from "./types";

export async function pollJobs(): Promise<Job[]> {
  const url = `${config.BRIDGE_URL}/api/jobs?username=${config.GITHUB_USERNAME}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        "x-api-key": config.BRIDGE_API_KEY,
      },
    });
    
    if (!response.ok) {
      console.error(`[Bridge] Failed to poll jobs: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json() as { username: string, jobs: Job[] };
    console.log(`[Bridge] Server confirmed presence for user: ${data.username}`);
    return data.jobs;
  } catch (error) {
    console.error("[Bridge] Error polling jobs:", error);
    return [];
  }
}

export async function fetchRegistrationToken(): Promise<string> {
  const url = `${config.BRIDGE_URL}/api/registration-token?username=${config.GITHUB_USERNAME}&repo=${config.GITHUB_REPO}`;

  try {
    const response = await fetch(url, {
      headers: {
        "x-api-key": config.BRIDGE_API_KEY,
      },
    });

    if (!response.ok) {
       const errorBody = await response.text();
       throw new Error(`Failed to fetch registration token: ${response.status} ${response.statusText}\n${errorBody}`);
    }

    const data = await response.json() as { token: string };
    return data.token;
  } catch (error) {
    console.error("[Bridge] Error fetching registration token:", error);
    throw error;
  }
}
