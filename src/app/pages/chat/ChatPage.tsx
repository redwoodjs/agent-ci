import { Prompt } from "./components/Prompt";
import { AuthGuard } from "@/app/components/AuthGuard";

export const ChatPage = ({ params }: { params: { containerId: string } }) => {
  return (
    <div style={{ height: "calc(100vh - 3rem)" }}>
      <AuthGuard>
        <Prompt
          containerId={params.containerId}
          seedUserMessage={`\
            Reference:
            - @/machinen/OVERVIEW.md
            - @/machinen/SUBTASKS.md

            Code is in: @/workspace/
          `}
        />
      </AuthGuard>
    </div>
  );
};
