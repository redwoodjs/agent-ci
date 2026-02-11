
import crypto from "node:crypto";
import { generateGitHubAppJWT } from "../src/github";

// Mock global crypto for Node.js environments if needed, 
// though Node 20+ has it globally.
if (!globalThis.crypto) {
    (globalThis as any).crypto = crypto.webcrypto;
}

async function testJWT() {
    console.log("Testing JWT generation...");
    try {
        const jwt = await generateGitHubAppJWT();
        console.log("Generated JWT:", jwt);

        const [headerB64, payloadB64, signatureB64] = jwt.split(".");
        
        const header = JSON.parse(atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")));
        const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));

        console.log("Header:", JSON.stringify(header, null, 2));
        console.log("Payload:", JSON.stringify(payload, null, 2));

        if (header.alg !== "RS256") throw new Error("Invalid algorithm");
        if (payload.iss !== "123456") throw new Error("Invalid issuer");
        
        console.log("JWT Structure looks sound!");
    } catch (error) {
        console.error("JWT Test failed:", error);
        process.exit(1);
    }
}

testJWT();
