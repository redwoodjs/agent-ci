"use client";

import { useAuthStatus } from "../AuthButton";
import { AuthButton } from "../AuthButton";

interface AuthGuardProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  showAuthUI?: boolean;
}

export function AuthGuard({ 
  children, 
  fallback,
  showAuthUI = true 
}: AuthGuardProps) {
  const { authStatus, loading } = useAuthStatus();

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <span className="text-gray-600">Checking authentication...</span>
        </div>
      </div>
    );
  }

  if (!authStatus?.authenticated) {
    if (fallback) {
      return <>{fallback}</>;
    }

    if (showAuthUI) {
      return (
        <div className="p-6 bg-gray-50 border border-gray-200 rounded-lg">
          <div className="text-center mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Authentication Required
            </h2>
            <p className="text-gray-600">
              You need to authenticate with Claude to access this feature.
            </p>
          </div>
          <AuthButton />
        </div>
      );
    }

    return null;
  }

  return <>{children}</>;
}

// Simple wrapper for protecting routes
export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}

// Auth guard that only shows children when authenticated (no fallback UI)
export function RequireAuth({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard showAuthUI={false}>
      {children}
    </AuthGuard>
  );
}