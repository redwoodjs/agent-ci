"use client";

import { createMeeting } from "./actions";

export const AudioConversation = () => {
  return (
    <div>
      AudioConversation
      <button onClick={async () => await createMeeting()}>
        Create Meeting
      </button>
    </div>
  );
};
