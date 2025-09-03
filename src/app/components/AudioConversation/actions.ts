"use server";

import { env } from "cloudflare:workers";

export let MEETING_ID: string | null = "bbbc2e77-82d4-460f-b461-998f587c6024";

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
    if (data?.success) {
      MEETING_ID = data?.data?.id;
    }
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

export async function getParticipantToken() {
  if (!MEETING_ID) {
    throw new Error("Meeting ID not found");
  }

  const body = JSON.stringify({
    name: "p4p8",
    preset_name: "group_call_host",
    custom_participant_id: "p4p8",
  });

  const url = `https://api.realtime.cloudflare.com/v2/meetings/${MEETING_ID}/participants`;
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: env.REALTIMEKIT_API_KEY,
    },
    body,
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();

    // {
    //   success: true,
    //   data: {
    //     token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmdJZCI6IjhiZGE0YTcxLTNjNjUtNDNmOS1hMmE1LTIyNjRiOWNiOTRkYyIsIm1lZXRpbmdJZCI6ImJiYjEwMDRmLTk2OTItNDAzMi1hNjllLTZkMThhMTEzNmRmZiIsInBhcnRpY2lwYW50SWQiOiJhYWEyYzM3Mi1lMzRkLTQ0ZjYtYTg5ZS1lMzc2MjhmZmE1NmMiLCJwcmVzZXRJZCI6ImFhZjZjYjU5LWE4NTAtNDYyZC1hZDlhLTJlNGY4NmFkYzVlOSIsImlhdCI6MTc1Njg0NTMzMCwiZXhwIjoxNzY1NDg1MzMwfQ.HYRpR09yvZW0f-QSZHJO8fHra6DyOiqISe1gAecN66jcXE0dAFQCIVeX4SDfZVd4a7_jAl0IvN0RVw-nf6h04ToOdQrNWCWJu3qrgHW7tFigViB8tffVYbn_QYHv05xy_V7ZvKiu5fG7YK3H__BKkZp303c77tg_F8ecozpTDpkHnaFj5PHGWGF6ntvr1E32WKA_rRQFSBQUxwf3sVll2VpZBxshCedWPk14zHjUguUzyT4elvZVJFsMqGnu3oSA-5O7ooMhyz78y0NKitQOME-bsjtbg_pfu5jer_DOl2YrcPELciXv4SSd7pTK-nBxJyBVPX4AZ07uAYbbGHyjlw',
    //     id: 'aaa2c372-e34d-44f6-a89e-e37628ffa56c',
    //     name: 'p4p8',
    //     custom_participant_id: 'p4p8',
    //     preset_id: 'aaf6cb59-a850-462d-ad9a-2e4f86adc5e9',
    //     sip_enabled: false,
    //     created_at: '2025-09-02T20:35:30.563Z',
    //     updated_at: '2025-09-02T20:35:30.563Z'
    //   }
    // }

    console.log(data);
  } catch (error) {
    console.error(error);
  }
}
