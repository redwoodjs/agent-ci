import { RequestInfo } from "rwsdk/worker";

export function Home({ ctx }: RequestInfo) {
  return (
    <div className="m-4">
      <h1 className="font-advercase font-bold text-3xl">Welcome to Machinen</h1>
      <div className="mt-4">
        <p>
          <a href="/auth/login" className="text-blue-600 hover:text-blue-800 underline">
            Login with Passkey
          </a>
        </p>
        <p className="mt-2">
          <a href="/projects" className="text-blue-600 hover:text-blue-800 underline">
            Go to Projects
          </a>
        </p>
      </div>
    </div>
  );
}