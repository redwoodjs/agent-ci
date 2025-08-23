import { Prompt } from "./components/Prompt";

// I think there's a concept of a session here.
// but for now let's just do a single conversation.

export const ChatPage = ({ params }: { params: { containerId: string } }) => {
  return (
    <div>
      // streaming responses
      <Prompt containerId={params.containerId} />
    </div>
  );
};
