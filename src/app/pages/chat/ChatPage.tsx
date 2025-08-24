import { Prompt } from "./components/Prompt";
import { AuthGuard } from "@/app/components/AuthGuard";

// I think there's a concept of a session here.
// but for now let's just do a single conversation.

export const ChatPage = ({ params }: { params: { containerId: string } }) => {
  return (
    <div className="h-full">
      <AuthGuard>
        <Prompt containerId={params.containerId} />
      </AuthGuard>
    </div>
  );
};
