import { MEETING_ID } from "./actions";
import { Controls } from "./Controls";
import { Meeting } from "./Meeting";

export const AudioConversation = () => {
  console.log("MEETING_ID", MEETING_ID);
  return (
    <div>
      AudioConversation
      {MEETING_ID && (
        <div>
          <h1>Meeting ID: {MEETING_ID}</h1>
          <Meeting />
        </div>
      )}
      <Controls />
    </div>
  );
};
