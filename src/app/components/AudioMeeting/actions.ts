"use server";

import { env } from "cloudflare:workers";
import { requestInfo } from "rwsdk/worker";

// Store meeting IDs per container
const MEETING_IDS = new Map<string, string>();

export async function GetActiveMeetingId({
  containerId,
}: {
  containerId: string;
}) {
  let meetingId = MEETING_IDS.get(containerId);
  if (!meetingId) {
    const meeting = await getActiveMeeting({ containerId });
    meetingId = meeting?.id;
    if (!meetingId) {
      const meeting = await createMeeting({ containerId });
      meetingId = meeting?.id;
    }
    if (meetingId) {
      MEETING_IDS.set(containerId, meetingId);
    }
  }
  return meetingId;
}

async function getActiveMeeting({ containerId }: { containerId: string }) {
  const url = `https://api.realtime.cloudflare.com/v2/meetings?search=machinen-${containerId}`;
  const options = {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: env.REALTIMEKIT_API_KEY,
    },
  };

  const response = await fetch(url, options);
  const json = await response.json<{
    success: boolean;
    data: Array<{
      id: string;
      title: string;
      craetedAt: string;
      updatedAt: string;
      status: "ACTIVE" | "INACTIVE";
    }>;
  }>();

  if (json.success) {
    const meetings = json.data.filter((meeting) => meeting.status === "ACTIVE");
    if (meetings.length > 0) {
      return meetings[0];
    }
  }
}

async function createMeeting({ containerId }: { containerId: string }) {
  const url = "https://api.realtime.cloudflare.com/v2/meetings";

  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: env.REALTIMEKIT_API_KEY,
    },
    body: JSON.stringify({
      title: `machinen-${containerId}`,
      ai_config: {
        transcription: {},
      },
    }),
  };

  const response = await fetch(url, options);
  const json = await response.json<{
    success: boolean;
    data: {
      id: string;
    };
  }>();

  return json?.data;
}

export async function getParticipantToken({
  containerId,
}: {
  containerId: string;
}) {
  const meetingId = await GetActiveMeetingId({ containerId });

  const body = JSON.stringify({
    name: requestInfo.ctx?.user?.email,
    preset_name: "group_call_host",
    custom_participant_id: requestInfo.ctx?.user?.id,
  });

  const url = `https://api.realtime.cloudflare.com/v2/meetings/${meetingId}/participants`;
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: env.REALTIMEKIT_API_KEY,
    },
    body,
  };

  const response = await fetch(url, options);
  const json = await response.json<{
    success: boolean;
    data: {
      token: string;
      id: string;
    };
  }>();

  return json.data.token;
}
