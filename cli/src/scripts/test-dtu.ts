const dtuUrl = "http://localhost:8910";

async function test() {
  console.log("Seeding job...");
  const seedRes = await fetch(`${dtuUrl}/_dtu/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "123", name: "test-job" }),
  });
  console.log("Seed status:", seedRes.status);

  console.log("Creating session...");
  const sessionRes = await fetch(`${dtuUrl}/_apis/distributedtask/pools/1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerName: "test-runner" }),
  });
  const sessionData = await sessionRes.json();
  const sessionId = sessionData.sessionId;
  console.log("Session ID:", sessionId);

  console.log("Polling for job...");
  const pollRes = await fetch(
    `${dtuUrl}/_apis/distributedtask/pools/1/messages?sessionId=${sessionId}`,
  );
  console.log("Poll status:", pollRes.status);
  if (pollRes.status === 200) {
    console.log("Poll body:", await pollRes.json());
  } else {
    console.log("Poll text:", await pollRes.text());
  }
}

test().catch(console.error);
