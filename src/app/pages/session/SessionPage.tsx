import { listContainers } from "@/container";
import { NewSessionButton } from "./NewSessionButton";

// we need to store a editor sessions\

// query docker and find the process with the name "rwsdk:latest"
// highlight all the process and the available ports
export async function SessionPage() {
  const containers = await listContainers();

  console.log(containers);

  return (
    <div>
      <h1 className="text-2xl font-bold">Machinen</h1>
      <p>Here is a list of currently available sessions</p>
      <ol>
        {containers.length === 0 && <li>No sessions found</li>}
        {containers.map((id) => (
          <li key={id}>
            <a href={`/editor/${id}/`}>{id}</a>
          </li>
        ))}
      </ol>

      <NewSessionButton />
    </div>
  );
}
