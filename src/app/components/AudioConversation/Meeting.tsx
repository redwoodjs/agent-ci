"use client";

import {
  useRealtimeKitMeeting,
  RealtimeKitProvider,
  useRealtimeKitClient,
} from "@cloudflare/realtimekit-react";
import { useEffect } from "react";
import {
  RtkMeeting,
  RtkNotifications,
  RtkParticipantsAudio,
  RtkAvatar,
  RtkMicToggle,
  RtkParticipants,
} from "@cloudflare/realtimekit-react-ui";

export const Meeting = () => {
  const [meeting, initMeeting] = useRealtimeKitClient();
  useEffect(() => {
    initMeeting({
      authToken:
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmdJZCI6IjhiZGE0YTcxLTNjNjUtNDNmOS1hMmE1LTIyNjRiOWNiOTRkYyIsIm1lZXRpbmdJZCI6ImJiYmMyZTc3LTgyZDQtNDYwZi1iNDYxLTk5OGY1ODdjNjAyNCIsInBhcnRpY2lwYW50SWQiOiJhYWE4MDUxZi04NGIzLTQzMGMtODU2YS1iNTk4MTc4M2Y0MTQiLCJwcmVzZXRJZCI6ImFhZjZjYjU5LWE4NTAtNDYyZC1hZDlhLTJlNGY4NmFkYzVlOSIsImlhdCI6MTc1Njg5Nzc5MiwiZXhwIjoxNzY1NTM3NzkyfQ.n-ush61G_j-9WY085VaCW2-W1bgXySsIVE9CjCl09Tw21kYvQ89gQcssEbZhje0KGrVM0mO2lWFG7z4vgKkF12lGWBgQwjuYFojwvk0A8y7uHTg1QJ9r7fs35cEIIDH5QWKjlrmnd-pF6LRVLQKvFgczZKAbua3w9_oWURv3t3oXOGQdBhNLlwNvh_LiKIIV_RQknmDm8bxJitxIIjVm6Vu0zAGZ1_Zx4NRqoGqVhZlxBKMcbWUCZvt2kjnHLnt8rrGlWBijPJo65cOn5gw4UVCVudZq2jKTN8db5RnRv0iTBF23SaZe3NXzrf8F0qcvXdgeQ7-Qt7dpLdLBhKwaPQ",
      defaults: {
        audio: false,
        video: false,
      },
    });
  }, []);
  return (
    <RealtimeKitProvider value={meeting} fallback={<i>Loading...</i>}>
      {/* <RtkMeeting meeting={meeting} mode="fixed" /> */}
      <RtkParticipantsAudio meeting={meeting} />
      <RtkNotifications
        meeting={meeting}
        config={{
          config: {
            // which notifications to show
            notifications: ["chat", "participant_joined", "participant_left"],
            // which notifications should have sounds
            notification_sounds: [
              "chat",
              "participant_joined",
              "participant_left",
            ],
            // maximum number of participant joined sound notifications
            participant_joined_sound_notification_limit: 10,
            // maximum number of chat message sound notifications
            participant_chat_message_sound_notification_limit: 10,
          },
        }}
      />
      <RtkAvatar size="md" participant={meeting?.self} />
      <RtkMicToggle size="sm" meeting={meeting} />
      <RtkParticipants
        meeting={meeting}
        style={{ height: "480px", maxWidth: "320px", backgroundColor: "#000" }}
      />
    </RealtimeKitProvider>
  );
};
