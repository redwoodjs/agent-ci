"use client";

import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { getParticipantToken } from "./actions";
import { MicIcon, MicOffIcon } from "lucide-react";

import {
  RealtimeKitProvider,
  useRealtimeKitClient,
  useRealtimeKitMeeting,
  useRealtimeKitSelector,
} from "@cloudflare/realtimekit-react";

export function AudioMeeting({ containerId }: { containerId: string }) {
  const [meeting, initMeeting] = useRealtimeKitClient();
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!authToken) {
      return;
    }

    initMeeting({
      authToken,
      defaults: {
        audio: false,
        video: false,
      },
    });
  }, [authToken]);

  return (
    <RealtimeKitProvider
      value={meeting}
      fallback={
        <Button
          disabled={joining}
          onClick={async () => {
            setJoining(true);
            const t = await getParticipantToken({ containerId });
            setAuthToken(t);
            setJoining(false);
          }}
        >
          <MicOffIcon />
        </Button>
      }
    >
      <>
        <audio id="audio-element" />
        <AudioRoom />
      </>
    </RealtimeKitProvider>
  );
}

function AudioRoom() {
  const { meeting } = useRealtimeKitMeeting();
  const roomState = useRealtimeKitSelector((m) => m.self.roomState);
  const audioEnabled = useRealtimeKitSelector((m) => m.self.audioEnabled);
  const audioTrack = useRealtimeKitSelector(
    (meeting) => meeting.self.audioTrack
  );
  // get all joined participants

  meeting.self.on("mediaPermissionError", ({ message, kind }) => {
    console.log(`Failed to capture ${kind}:  ${message}`);
  });

  useEffect(() => {
    async function join() {
      if (!meeting) {
        return;
      }
      await meeting.join();
      await await meeting.self.enableAudio();
    }
    join();
  }, [meeting]);

  useEffect(() => {
    if (audioEnabled && audioTrack) {
      const el = document.getElementById("audio-element") as HTMLAudioElement;
      if (el) {
        const stream = new MediaStream();
        stream.addTrack(audioTrack);
        el.srcObject = stream;
        el.play();
        console.log("playing");
      }
    }
  }, [audioEnabled, audioTrack]);

  return (
    <div>
      {roomState} {audioEnabled ? <MicIcon /> : <MicOffIcon />}
    </div>
  );
}
