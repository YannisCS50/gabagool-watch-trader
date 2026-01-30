// HTTP Keep-Alive agent configuration
// MUST be imported before axios/SDK to configure defaults

import http from 'node:http';
import https from 'node:https';
import axios from 'axios';

// Create persistent agents with connection pooling
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60_000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60_000,
});

// Apply globally to axios (used by @polymarket/clob-client)
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 30_000;

console.log('[http-agent] Keep-alive agents configured');

export { httpAgent, httpsAgent };
