"use client";

import { Register } from "../components/Register";
import { RequestInfo } from "rwsdk/worker";

export function RegisterPage({ ctx }: RequestInfo) {
  const handleSuccess = () => {
    // Redirect to projects page on successful registration
    window.location.href = "/projects";
  };

  const handleError = (error: string) => {
    console.error("Registration error:", error);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-white">
            Create your account
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
            Or{" "}
            <a
              href="/auth/login"
              className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              sign in to your existing account
            </a>
          </p>
        </div>
        <Register onSuccess={handleSuccess} onError={handleError} />
      </div>
    </div>
  );
}
