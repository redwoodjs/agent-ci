"use client";

import { useState } from "react";

interface OAuthCodeInputProps {
  onSuccess?: () => void;
  onError?: (error: string) => void;
}

export function OAuthCodeInput({ onSuccess, onError }: OAuthCodeInputProps) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!code.trim()) {
      setError("Please enter the authorization code");
      return;
    }

    try {
      setLoading(true);
      setError("");
      
      const response = await fetch('/api/auth/claude/exchange', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code: code.trim() }),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setCode("");
        onSuccess?.();
      } else {
        const errorMessage = result.error || 'Authentication failed';
        setError(errorMessage);
        onError?.(errorMessage);
      }
    } catch (err) {
      const errorMessage = 'Network error. Please try again.';
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-900 mb-2">
          Complete Claude Authentication
        </h3>
        <ol className="text-sm text-blue-800 space-y-1 mb-3">
          <li>1. Click "Login with Claude" to open the OAuth page</li>
          <li>2. Authorize the application on Claude's website</li>
          <li>3. Copy the full code from the callback URL</li>
          <li>4. Paste it below and click "Complete Login"</li>
        </ol>
        
        <button
          onClick={() => setShowInstructions(!showInstructions)}
          className="text-blue-600 hover:text-blue-800 text-sm underline"
        >
          {showInstructions ? 'Hide' : 'Show'} detailed instructions
        </button>
        
        {showInstructions && (
          <div className="mt-3 text-xs text-blue-700 bg-blue-100 p-3 rounded">
            <p className="font-medium mb-2">Detailed Steps:</p>
            <p className="mb-2">
              After authorizing on Claude's website, you'll be redirected to a URL that looks like:
            </p>
            <code className="block bg-white p-2 rounded text-xs mb-2">
              https://console.anthropic.com/oauth/code/callback?code=LONG_CODE_HERE#state=STATE_HERE
            </code>
            <p>
              Copy everything after "code=" including the "#state=" part. 
              The full code should look like: <code>your_code_here#your_state_here</code>
            </p>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label htmlFor="oauth-code" className="block text-sm font-medium text-gray-700 mb-1">
            Authorization Code
          </label>
          <textarea
            id="oauth-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste the full authorization code here (including #state=...)"
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm font-mono"
          />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3">
            <p className="text-red-800 text-sm">{error}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !code.trim()}
          className="w-full px-4 py-2 bg-green-500 hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded font-medium transition-colors"
        >
          {loading ? 'Completing Login...' : 'Complete Login'}
        </button>
      </form>
    </div>
  );
}