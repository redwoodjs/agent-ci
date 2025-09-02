import { env } from "cloudflare:workers";

// we'll store this somewhere.

export async function createMeeting() {
  const url = "https://api.realtime.cloudflare.com/v2/meetings";

  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: env.REALTIMEKIT_API_KEY,
    },
    body: JSON.stringify({
      title: "machinen",
      ai_config: {
        transcription: {},
      },
    }),
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}
