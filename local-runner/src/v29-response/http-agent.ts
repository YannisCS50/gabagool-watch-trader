/**
 * V29 Response-Based Strategy - HTTP Agent
 * Configures axios for Polymarket API calls
 */

import { Agent } from 'https';
import axios from 'axios';

// Configure axios defaults for Polymarket
const agent = new Agent({
  keepAlive: true,
  maxSockets: 20,
  timeout: 30000,
});

axios.defaults.httpsAgent = agent;
axios.defaults.timeout = 30000;

console.log('[V29R] HTTP agent configured');
