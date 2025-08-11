import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { getProjectInfo } from "@/app/services/project";

export async function ProcessListPage({
  params,
}: {
  params: { projectId: string; containerId: string };
}) {
  const { projectId, containerId } = params;
  const sandbox = getSandbox(env.Sandbox, containerId);
  const processes = await sandbox.listProcesses();
  const { runOnBoot } = await getProjectInfo(containerId);

  const upcomingCommands = runOnBoot;
  const runOnBootProcesses = processes.filter(
    (p) => p.sessionId === "runOnBoot"
  );
  const completedCommandsCount = runOnBootProcesses.filter(
    (p) => p.exitCode !== undefined && p.exitCode !== null
  ).length;

  const nonBootProcesses = processes.filter((p) => p.sessionId !== "runOnBoot");

  return (
    <div>
      <h1>Process List</h1>

      {runOnBootProcesses.length > 0 && (
        <div
          style={{
            marginBottom: "30px",
            padding: "15px",
            border: "2px solid #e0e0e0",
            borderRadius: "8px",
            backgroundColor: "#f9f9f9",
          }}
        >
          <h2 style={{ color: "#2563eb", marginTop: "0" }}>
            🚀 Boot Commands Progress
          </h2>
          <div
            style={{ marginBottom: "15px", fontSize: "14px", color: "#666" }}
          >
            Progress: {completedCommandsCount}/{upcomingCommands.length}{" "}
            commands completed
          </div>
          <ol style={{ paddingLeft: "20px" }}>
            {upcomingCommands.map((command, index) => {
              const isCompleted = index < completedCommandsCount;
              const isCurrentlyRunning =
                index === completedCommandsCount &&
                runOnBootProcesses.some(
                  (p) => p.exitCode === undefined || p.exitCode === null
                );

              // Find corresponding process by matching the command text
              const correspondingProcess =
                runOnBootProcesses.find(
                  (p) => p.command && p.command.includes(command.trim())
                ) || runOnBootProcesses[index];

              const content = (
                <>
                  {isCompleted ? "✅" : isCurrentlyRunning ? "🔄" : "⏳"}{" "}
                  {command.trim()}
                </>
              );

              return (
                <li
                  key={index}
                  style={{
                    marginBottom: "5px",
                  }}
                >
                  {correspondingProcess ? (
                    <a
                      href={`/logs/${containerId}/${correspondingProcess.id}`}
                      style={{
                        color: isCompleted
                          ? "#16a34a"
                          : isCurrentlyRunning
                          ? "#ea580c"
                          : "#6b7280",
                        fontWeight: isCurrentlyRunning ? "bold" : "normal",
                        textDecoration: "none",
                      }}
                    >
                      {content}
                    </a>
                  ) : (
                    <span
                      style={{
                        color: isCompleted
                          ? "#16a34a"
                          : isCurrentlyRunning
                          ? "#ea580c"
                          : "#6b7280",
                        fontWeight: isCurrentlyRunning ? "bold" : "normal",
                      }}
                    >
                      {content}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <div>
        <h2>All Processes</h2>
        {nonBootProcesses.length === 0 ? (
          <p style={{ color: "#6b7280", fontStyle: "italic" }}>
            No user processes running
          </p>
        ) : (
          <ol>
            {nonBootProcesses.map((process) => (
              <li key={process.pid}>
                <a href={`/logs/${containerId}/${process.id}`}>
                  {process.pid} {process.command} {process.status}{" "}
                  {process.exitCode}
                </a>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
