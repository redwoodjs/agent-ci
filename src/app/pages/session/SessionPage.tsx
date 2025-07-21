import { NewSessionButton } from "./NewSessionButton";

// we need to store a editor sessions\

// query docker and find the process with the name "rwsdk:latest"
// highlight all the process and the available ports

type DockerProcess = {
  Command: string;
  CreatedAt: string;
  ID: string;
  Image: string;
  Labels: string;
  LocalVolumes: string;
  Mounts: string;
  Names: string;
  Networks: string;
  Platform: string;
  Ports: string;
  RunningFor: string;
  Size: string;
  State: string;
  Status: string;
};

async function getSessions() {
  const response = await fetch(`http://localhost:5173/__machinen/process/list`);
  const result = (await response.json()) as {
    success: boolean;
    data: DockerProcess[];
    stdout: string;
    stderr: string;
  };
  return result?.data || [];
}

export async function SessionPage() {
  const sessions = await getSessions();

  return (
    <div>
      <h1>Machinen</h1>
      <p>Here is a list of currently available sessions</p>
      <ol>
        {sessions.map((session) => (
          <li key={session.ID}>
            <b>{session.Names}</b>
            <br />
            {session.Ports}
            {/* 0.0.0.0:32774->8910/tcp, [::]:32774->8910/tcp */}
            <hr />
            <br />
            <a
              href={`/editor/${
                session.Ports.split(",")[0].split(":")[1].split("->")[0]
              }/`}
            >
              Open
            </a>
            <hr />
          </li>
        ))}
      </ol>

      <NewSessionButton />
    </div>
  );
}
