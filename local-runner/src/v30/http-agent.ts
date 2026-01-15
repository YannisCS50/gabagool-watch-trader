/**
 * V30 HTTP Agent Configuration
 * 
 * Configures axios with persistent HTTP/HTTPS agents for connection reuse.
 * This MUST be imported BEFORE any @polymarket/clob-client imports!
 * 
 * Benefits:
 * - TLS session reuse: saves ~200-300ms per request
 * - TCP connection reuse: saves ~50-100ms per request
 * - Reduced latency through VPN tunnels
 */

import https from 'node:https';
import http from 'node:http';
import axios from 'axios';

// Create persistent agents with keep-alive
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,      // Keep connections alive for 30s
  maxSockets: 10,             // Max 10 concurrent connections per host
  maxFreeSockets: 5,          // Keep 5 idle connections ready
  timeout: 60000,             // 60s socket timeout
  scheduling: 'fifo',         // First-in-first-out for consistent latency
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 60000,
  scheduling: 'fifo',
});

// Apply to axios defaults GLOBALLY
// This affects ALL axios instances, including those created by @polymarket/clob-client
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.httpAgent = httpAgent;

// Also set connection timeout defaults
axios.defaults.timeout = 30000;

// Track connection stats
let requestCount = 0;
let reuseCount = 0;

// Add response interceptor to track connection reuse
axios.interceptors.response.use(
  (response) => {
    requestCount++;
    // Check if connection was reused (socket already existed)
    const socket = (response.request as any)?.socket;
    if (socket && socket._hadConnection) {
      reuseCount++;
    }
    return response;
  },
  (error) => {
    requestCount++;
    return Promise.reject(error);
  }
);

export function getHttpStats(): { requests: number; reused: number; reuseRate: string } {
  const rate = requestCount > 0 ? ((reuseCount / requestCount) * 100).toFixed(1) : '0';
  return {
    requests: requestCount,
    reused: reuseCount,
    reuseRate: `${rate}%`,
  };
}

export function logHttpStats(): void {
  const stats = getHttpStats();
  console.log(`[HTTP Agent] Requests: ${stats.requests} | Reused: ${stats.reused} (${stats.reuseRate})`);
}

// Log on process exit
process.on('beforeExit', () => {
  logHttpStats();
});

console.log('[V30] ✅ HTTP keep-alive agents configured (TLS reuse enabled)');
