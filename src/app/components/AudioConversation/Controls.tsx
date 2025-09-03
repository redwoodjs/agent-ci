"use client";

import { createMeeting, getParticipantToken } from "./actions";
import { Button } from "../ui/button";

export function Controls() {
  return (
    <div>
      <Button onClick={async () => await createMeeting()}>
        Create Meeting
      </Button>
      <Button onClick={async () => await getParticipantToken()}>
        Join Meeting
      </Button>
    </div>
  );
}
