
import { SECRETS } from "./secrets";

/**
 * Generates a GitHub App JWT using the Web Crypto API.
 */
export async function generateGitHubAppJWT(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + (10 * 60),
    iss: SECRETS.GITHUB_APP_ID,
  };

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const privateKey = await importPrivateKey(SECRETS.GITHUB_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(dataToSign)
  );

  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${dataToSign}.${encodedSignature}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Remove PEM headers and whitespace
  const pemHeader = "-----BEGIN RSA PRIVATE KEY-----";
  const pemFooter = "-----END RSA PRIVATE KEY-----";
  const pemHeaderPKCS8 = "-----BEGIN PRIVATE KEY-----";
  const pemFooterPKCS8 = "-----END PRIVATE KEY-----";

  let base64Contents = "";
  if (pem.includes(pemHeader)) {
    base64Contents = pem.replace(pemHeader, "").replace(pemFooter, "").replace(/\s/g, "");
  } else if (pem.includes(pemHeaderPKCS8)) {
    base64Contents = pem.replace(pemHeaderPKCS8, "").replace(pemFooterPKCS8, "").replace(/\s/g, "");
  } else {
    throw new Error("Invalid Private Key format. Expected PKCS#1 or PKCS#8 PEM.");
  }

  const binaryDerString = atob(base64Contents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

  return await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
}


/**
 * Gets a registration token for a specific repository.
 */
export async function getRegistrationToken(installationId: string, repositoryName: string): Promise<string> {
  const token = await getInstallationToken(installationId, repositoryName, { actions: "write" });
  const url = `${SECRETS.GITHUB_API_URL}/repos/${repositoryName}/actions/runners/registration-token`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "oa-1-bridge",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to get registration token: ${response.status} ${response.statusText}\n${errorBody}`);
  }

  const data: any = await response.json();
  return data.token;
}

/**
 * Finds the installation ID for a given repository.
 */
export async function getInstallationIdForRepo(owner: string, repo: string): Promise<string> {
    const jwt = await generateGitHubAppJWT();
    const url = `${SECRETS.GITHUB_API_URL}/repos/${owner}/${repo}/installation`;

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "oa-1-bridge",
        },
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Failed to get installation ID for ${owner}/${repo}: ${response.status} ${response.statusText}\n${errorBody}`);
    }

    const data: any = await response.json();
    return data.id.toString();
}

/**
 * Exchanges a GitHub App JWT for an installation access token.
 */
export async function getInstallationToken(
    installationId: string, 
    repositoryName: string, 
    permissions: Record<string, string> = { actions: "read", contents: "read", metadata: "read" }
): Promise<string> {
  const jwt = await generateGitHubAppJWT();
  const url = `${SECRETS.GITHUB_API_URL}/app/installations/${installationId}/access_tokens`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "oa-1-bridge",
    },
    body: JSON.stringify({
        repositories: [repositoryName.split("/")[1]], // Only grant access to this repo
        permissions
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${response.statusText}\n${errorBody}`);
  }

  const data: any = await response.json();
  return data.token;
}

