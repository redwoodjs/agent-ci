"use client";

import { useState, useEffect } from "react";

interface AuthStatus {
  authenticated: boolean;
  expires_at?: number;
}

export function ClaudeAuth() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>({
    authenticated: false,
  });
  const [error, setError] = useState("");
  
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [codeSubmitting, setCodeSubmitting] = useState(false);

  useEffect(() => {
    checkAuthStatus();

    // Check for OAuth callback success/error
    const params = new URLSearchParams(window.location.search);
    if (params.get("success")) {
      setError("");
      checkAuthStatus();
    } else if (params.get("error")) {
      setError("OAuth authentication failed");
    }
  }, []);

  const checkAuthStatus = async () => {
    try {
      const response = await fetch("/api/auth/status");
      const status = await response.json();
      setAuthStatus(status);
    } catch (err) {
      console.error("Failed to check auth status:", err);
    }
  };

  const handleLogin = () => {
    // Open OAuth in new tab and show code input
    window.open("/api/auth/claude/login", "_blank");
    setShowCodeInput(true);
  };

  const handleCodeSubmit = async () => {
    if (!authCode.trim()) return;

    setCodeSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/auth/claude/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: authCode.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Token exchange failed");
      }

      setShowCodeInput(false);
      setAuthCode("");
      checkAuthStatus();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      console.error("Exchange error:", errorMessage);
      setError(`Exchange failed: ${errorMessage}`);
    } finally {
      setCodeSubmitting(false);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Claude Authentication</h2>
      
      {/* Auth Status */}
      <div className="mb-4 p-4 border rounded-lg">
        {authStatus.authenticated ? (
          <div className="text-green-600">
            ✅ Authenticated with Claude
            {authStatus.expires_at && (
              <div className="text-sm text-gray-600 mt-1">
                Token expires:{" "}
                {new Date(authStatus.expires_at).toLocaleString()}
              </div>
            )}
          </div>
        ) : (
          <div className="text-red-600">❌ Not authenticated</div>
        )}
      </div>

      {/* Login Button */}
      {!authStatus.authenticated && !showCodeInput && (
        <div className="mb-4">
          <button
            onClick={handleLogin}
            className="bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold"
          >
            Login with Claude
          </button>
        </div>
      )}

      {/* Code Input */}
      {showCodeInput && !authStatus.authenticated && (
        <div className="mb-4 p-4 border rounded-lg bg-blue-50">
          <h3 className="text-lg font-semibold mb-3">
            Complete Authentication
          </h3>
          <div className="space-y-4">
            <div className="text-sm text-gray-700">
              <p className="mb-2">After authorizing in the new tab:</p>
              <ol className="list-decimal list-inside space-y-1 ml-4">
                <li>You'll be redirected to console.anthropic.com</li>
                <li>Look for an authorization code on that page</li>
                <li>Copy the code and paste it below</li>
              </ol>
            </div>
            <input
              type="text"
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              placeholder="Paste authorization code here..."
              className="w-full p-3 border rounded-lg"
              disabled={codeSubmitting}
            />
            <div className="flex space-x-3">
              <button
                onClick={handleCodeSubmit}
                disabled={codeSubmitting || !authCode.trim()}
                className="bg-green-500 hover:bg-green-600 disabled:bg-gray-400 text-white px-6 py-3 rounded-lg font-semibold"
              >
                {codeSubmitting ? "Exchanging..." : "Complete Login"}
              </button>
              <button
                onClick={() => {
                  setShowCodeInput(false);
                  setAuthCode("");
                }}
                className="bg-gray-500 hover:bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded-lg">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Success Message */}
      {authStatus.authenticated && (
        <div className="mb-4 text-sm text-gray-600">
          You can now access Claude in any container using the Claude buttons above.
        </div>
      )}
    </div>
  );
}