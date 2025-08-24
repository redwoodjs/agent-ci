"use client";

import { useState, useEffect } from "react";
import { OAuthCodeInput } from "../OAuthCodeInput";

interface AuthStatus {
  authenticated: boolean;
  expires_at?: number;
}

export function AuthButton() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [showCodeInput, setShowCodeInput] = useState(false);

  // Check authentication status on component mount
  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/auth/claude/status');
      const status = await response.json();
      setAuthStatus(status);
    } catch (error) {
      console.error('Failed to check auth status:', error);
      setAuthStatus({ authenticated: false });
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = () => {
    // Open OAuth URL in new tab so user can copy the code
    window.open('/api/auth/claude/login', '_blank');
    // Show the code input interface
    setShowCodeInput(true);
  };

  const handleAuthSuccess = () => {
    setShowCodeInput(false);
    checkAuthStatus(); // Refresh auth status
  };

  const handleAuthError = (error: string) => {
    console.error('OAuth error:', error);
    // Keep code input open so user can try again
  };

  const handleLogout = async () => {
    try {
      setLoggingOut(true);
      const response = await fetch('/api/auth/claude/logout', {
        method: 'POST',
      });
      
      if (response.ok) {
        setAuthStatus({ authenticated: false });
        // Optionally refresh the page to clear any cached data
        window.location.reload();
      } else {
        console.error('Logout failed');
      }
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setLoggingOut(false);
    }
  };

  if (loading) {
    return (
      <button 
        disabled 
        className="px-4 py-2 bg-gray-300 text-gray-600 rounded cursor-not-allowed"
      >
        Checking...
      </button>
    );
  }

  if (authStatus?.authenticated) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-500 rounded-full"></div>
          <span className="text-sm text-green-700 font-medium">
            Authenticated with Claude
          </span>
        </div>
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="px-4 py-2 bg-red-500 hover:bg-red-600 disabled:bg-red-300 text-white rounded font-medium transition-colors"
        >
          {loggingOut ? 'Logging out...' : 'Logout'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-red-500 rounded-full"></div>
          <span className="text-sm text-red-700 font-medium">
            Not authenticated
          </span>
        </div>
        <button
          onClick={handleLogin}
          className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded font-medium transition-colors"
        >
          Login with Claude
        </button>
        {showCodeInput && (
          <button
            onClick={() => setShowCodeInput(false)}
            className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800 underline"
          >
            Cancel
          </button>
        )}
      </div>
      
      {showCodeInput && (
        <OAuthCodeInput 
          onSuccess={handleAuthSuccess}
          onError={handleAuthError}
        />
      )}
    </div>
  );
}

// Hook for other components to use auth status
export function useAuthStatus() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const checkAuthStatus = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/auth/claude/status');
      const status = await response.json();
      setAuthStatus(status);
    } catch (error) {
      console.error('Failed to check auth status:', error);
      setAuthStatus({ authenticated: false });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuthStatus();
  }, []);

  return { authStatus, loading, refetch: checkAuthStatus };
}