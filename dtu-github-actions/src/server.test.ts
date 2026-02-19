import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { server, jobs } from './server.js';
import { config } from './config.js';
import http from 'node:http';

const PORT = config.DTU_PORT + 1; // Use a different port for tests

async function request(method: string, path: string, body?: any) {
  return new Promise<{ status: number, body: any }>((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {}
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode || 0,
            body: data ? JSON.parse(data) : null
          });
        } catch (e) {
          resolve({ status: res.statusCode || 0, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('DTU Server', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(PORT, () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('should handle health check', async () => {
    const res = await request('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('online');
  });

  it('should seed a job', async () => {
    const job = { id: 123, name: 'test-job' };
    const res = await request('POST', '/_dtu/seed', job);
    expect(res.status).toBe(201);
    expect(res.body.jobId).toBe('123');
    expect(jobs.get('123')).toEqual(job);
  });

  it('should retrieve a seeded job', async () => {
    const res = await request('GET', '/repos/owner/repo/actions/jobs/123');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(123);
  });

  it('should handle missing job', async () => {
    const res = await request('GET', '/repos/owner/repo/actions/jobs/999');
    expect(res.status).toBe(404);
  });

  it('should handle installation lookup', async () => {
    const res = await request('GET', '/repos/owner/repo/installation');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(12345678);
    expect(res.body.access_tokens_url).toContain('/app/installations/12345678/access_tokens');
  });

  it('should handle access token exchange', async () => {
    const res = await request('POST', '/app/installations/12345678/access_tokens');
    expect(res.status).toBe(201);
    expect(res.body.token).toContain('ghs_mock_token_12345678');
  });

  it('should handle registration token generation', async () => {
    const res = await request('POST', '/repos/owner/repo/actions/runners/registration-token');
    expect(res.status).toBe(201);
    expect(res.body.token).toContain('ghr_mock_registration_token');
  });
});
