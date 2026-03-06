import crypto from "node:crypto";

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "dev-secret";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://localhost:5173/api/webhook";

const payload = {
  action: "queued",
  workflow_job: {
    id: 123456789,
    run_id: 987654321,
    status: "queued",
    name: "build-and-test",
  },
  repository: {
    owner: {
      login: "peterp",
    },
    name: "machinen",
  },
};

async function sendWebhook() {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

  console.log("Sending webhook to:", WEBHOOK_URL);
  console.log("Secret used:", WEBHOOK_SECRET);
  console.log("Payload:", JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-delivery": crypto.randomUUID(),
        "x-github-event": "workflow_job",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    });

    console.log("Response status:", response.status);
    console.log("Response text:", await response.text());
  } catch (error) {
    console.error("Error sending webhook:", error);
  }
}

sendWebhook();
