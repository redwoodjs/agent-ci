import { NewInstanceButton } from "./NewSessionButton";
// import { ClaudeAuth } from "./ClaudeAuth";
import { SessionControls } from "@/app/components/SessionControls";

import { listInstances } from "@/container";

export async function SessionPage() {
  const instances = await listInstances();

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">Machinen</h1>

      {/* Claude Authentication Section */}
      <div className="mb-8">{/* <ClaudeAuth /> */}</div>

      {/* Container Sessions */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Container Sessions</h2>
        {instances.length === 0 ? (
          <p className="text-gray-600 mb-4">No sessions found</p>
        ) : (
          <div className="space-y-3 mb-4">
            {instances.map((i) => (
              <div
                key={"container-" + i.id}
                className="flex items-center justify-between p-4 border border-gray-200 rounded-lg bg-gray-50"
              >
                <div className="font-mono text-sm text-gray-700">{i.id}</div>
                <SessionControls containerId={i.id} />
              </div>
            ))}
          </div>
        )}
        <NewInstanceButton />
      </div>
    </div>
  );
}
