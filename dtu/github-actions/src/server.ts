import http from 'node:http';
import { config } from './config.js';

/**
 * Digital Twin Universe (DTU) - GitHub API Mock Server
 * 
 * This server mirrors the GitHub REST API for Actions.
 * It maintains an in-memory store of job metadata seeded by simulation scripts.
 */

const jobs = new Map<string, any>();

const server = http.createServer((req, res) => {
  const { method, url } = req;

  console.log(`[DTU] ${method} ${url}`);

  // 1. Internal Seeding Endpoint
  if (method === 'POST' && url === '/_dtu/seed') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const jobId = payload.id?.toString();
        if (jobId) {
          jobs.set(jobId, payload);
          console.log(`[DTU] Seeded job: ${jobId}`);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', jobId }));
        } else {
          res.writeHead(400);
          res.end('Missing job ID');
        }
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  // 2. GitHub REST API Mirror
  const jobMatch = url?.match(/\/repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)/);
  if (method === 'GET' && jobMatch) {
    const jobId = jobMatch[1];
    const job = jobs.get(jobId);
    if (job) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(job));
    } else {
      console.warn(`[DTU] Job not found: ${jobId}`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found (DTU Mock)' }));
    }
    return;
  }

  // 3. GitHub App Token Exchange Mock
  const tokenMatch = url?.match(/\/app\/installations\/(\d+)\/access_tokens/);
  if (method === 'POST' && tokenMatch) {
    const installationId = tokenMatch[1];
    const authHeader = req.headers['authorization'];
    console.log(`[DTU] Token exchange for installation: ${installationId}`);
    if (authHeader) {
      console.log(`[DTU] Received JWT: ${authHeader.substring(0, 20)}...`);
    }
    
    // Return a mock installation token
    const response = {
      token: `ghs_mock_token_${installationId}_${Math.random().toString(36).substring(7)}`,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      permissions: {
        actions: "read",
        metadata: "read"
      },
      repository_selection: "selected"
    };

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  // Health check
  if ((method === 'GET' || method === 'HEAD') && url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(method === 'GET' ? JSON.stringify({ status: 'online', seededJobs: jobs.size }) : undefined);
    return;
  }

  res.writeHead(404);
  res.end('Not Found (DTU Mock)');
});

server.listen(config.DTU_PORT, () => {
  console.log(`[DTU] Mock GitHub API server running at http://localhost:${config.DTU_PORT}`);
});
