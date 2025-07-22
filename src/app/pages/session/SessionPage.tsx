import { listContainers } from "@/container";
import { NewSessionButton } from "./NewSessionButton";
import { ClaudeAuth } from "./ClaudeAuth";

export async function SessionPage() {
  const containers = await listContainers();

  console.log(containers);

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">Machinen</h1>
      
      {/* Claude Authentication Section */}
      <div className="mb-8">
        <ClaudeAuth />
      </div>

      {/* Container Sessions */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Container Sessions</h2>
        {containers.length === 0 ? (
          <p className="text-gray-600 mb-4">No sessions found</p>
        ) : (
          <div className="space-y-3 mb-4">
            {containers.map((id) => (
              <div key={id} className="flex items-center justify-between p-4 border border-gray-200 rounded-lg bg-gray-50">
                <div className="font-mono text-sm text-gray-700">{id}</div>
                <div className="flex space-x-2">
                  <a 
                    href={`/editor/${id}/`} 
                    className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium"
                  >
                    Editor
                  </a>
                  <a 
                    href={`/claude/${id}`} 
                    className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg text-sm font-medium"
                  >
                    Claude
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
        <NewSessionButton />
      </div>
    </div>
  );
}
