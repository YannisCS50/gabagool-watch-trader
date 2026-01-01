import { ethers, providers } from 'ethers';

// Polygon RPC endpoints (fallback list) - more endpoints for better rate limit handling
const RPC_ENDPOINTS = [
  'https://polygon.llamarpc.com',
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon-mainnet.public.blastapi.io',
  'https://rpc-mainnet.matic.quiknode.pro',
  'https://polygon-rpc.com',
  'https://1rpc.io/matic',
  'https://polygon.drpc.org',
];

// Rate limiting state
let _lastRpcCall = 0;
const MIN_RPC_INTERVAL_MS = 250; // Min 250ms between calls
let _rateLimitBackoffUntil = 0;
let _consecutiveErrors = 0;

// CTF Contract address
export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// USDC address on Polygon
export const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// PayoutRedemption event signature
// event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)
export const PAYOUT_REDEMPTION_TOPIC = ethers.utils.id(
  'PayoutRedemption(address,address,bytes32,bytes32,uint256[],uint256)'
);

// Full ABI for parsing
export const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
  'event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)',
];

export interface PayoutRedemptionEvent {
  redeemer: string;
  collateralToken: string;
  parentCollectionId: string;
  conditionId: string;
  indexSets: number[];
  payout: string; // In wei (USDC has 6 decimals)
  payoutUSDC: number;
  transactionHash: string;
  blockNumber: number;
}

let _provider: providers.JsonRpcProvider | null = null;
let _currentRpcIndex = 0;

/**
 * Check if we're in rate limit backoff
 */
function isInBackoff(): boolean {
  return Date.now() < _rateLimitBackoffUntil;
}

/**
 * Set rate limit backoff with exponential increase
 */
function setRateLimitBackoff(errorMsg: string): void {
  // Parse "retry in 10m0s" style messages
  let backoffMs = 30000; // Default 30s
  
  const match = errorMsg.match(/retry in (\d+)m(\d+)s/);
  if (match) {
    const mins = parseInt(match[1], 10);
    const secs = parseInt(match[2], 10);
    backoffMs = (mins * 60 + secs) * 1000;
  }
  
  // Cap at 10 minutes
  backoffMs = Math.min(backoffMs, 10 * 60 * 1000);
  
  _rateLimitBackoffUntil = Date.now() + backoffMs;
  console.log(`⏳ RPC rate limit backoff for ${backoffMs / 1000}s`);
  
  // Also rotate provider
  rotateProvider();
}

/**
 * Throttle RPC calls
 */
async function throttleRpc(): Promise<void> {
  // Wait if in backoff
  if (isInBackoff()) {
    const waitTime = _rateLimitBackoffUntil - Date.now();
    console.log(`⏳ Waiting ${Math.ceil(waitTime / 1000)}s for rate limit backoff...`);
    await new Promise(r => setTimeout(r, waitTime));
  }
  
  // Ensure minimum interval between calls
  const now = Date.now();
  const elapsed = now - _lastRpcCall;
  if (elapsed < MIN_RPC_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_RPC_INTERVAL_MS - elapsed));
  }
  _lastRpcCall = Date.now();
}

/**
 * Handle RPC error and check for rate limiting
 */
export function handleRpcError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  
  // Check for rate limit errors
  if (msg.includes('rate limit') || msg.includes('-32090') || msg.includes('Too many requests')) {
    setRateLimitBackoff(msg);
    _consecutiveErrors++;
    return true; // Indicates rate limit, should retry
  }
  
  _consecutiveErrors++;
  
  // After 3 consecutive errors, rotate provider
  if (_consecutiveErrors >= 3) {
    rotateProvider();
    _consecutiveErrors = 0;
  }
  
  return false;
}

/**
 * Get a working provider with fallback
 */
export function getProvider(): providers.JsonRpcProvider {
  if (_provider) return _provider;
  _provider = new providers.JsonRpcProvider(RPC_ENDPOINTS[_currentRpcIndex]);
  return _provider;
}

/**
 * Rotate to next RPC on failure
 */
export function rotateProvider(): providers.JsonRpcProvider {
  _currentRpcIndex = (_currentRpcIndex + 1) % RPC_ENDPOINTS.length;
  _provider = new providers.JsonRpcProvider(RPC_ENDPOINTS[_currentRpcIndex]);
  console.log(`🔄 Rotated to RPC: ${RPC_ENDPOINTS[_currentRpcIndex]}`);
  _consecutiveErrors = 0;
  return _provider;
}

/**
 * Parse PayoutRedemption events from a transaction receipt
 */
export function parsePayoutRedemptionEvents(
  receipt: providers.TransactionReceipt
): PayoutRedemptionEvent[] {
  const iface = new ethers.utils.Interface(CTF_ABI);
  const events: PayoutRedemptionEvent[] = [];

  for (const log of receipt.logs) {
    // Only parse logs from CTF contract
    if (log.address.toLowerCase() !== CTF_ADDRESS.toLowerCase()) continue;
    
    // Check if it's a PayoutRedemption event
    if (log.topics[0] !== PAYOUT_REDEMPTION_TOPIC) continue;

    try {
      const parsed = iface.parseLog(log);
      const payout = parsed.args.payout as ethers.BigNumber;
      
      events.push({
        redeemer: parsed.args.redeemer,
        collateralToken: parsed.args.collateralToken,
        parentCollectionId: parsed.args.parentCollectionId,
        conditionId: parsed.args.conditionId,
        indexSets: parsed.args.indexSets.map((n: ethers.BigNumber) => n.toNumber()),
        payout: payout.toString(),
        payoutUSDC: parseFloat(ethers.utils.formatUnits(payout, 6)),
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
      });
    } catch (e) {
      // Skip unparseable logs
    }
  }

  return events;
}

/**
 * Get transaction receipt with retry and rate limit handling
 */
export async function getReceiptWithRetry(
  txHash: string,
  maxRetries = 5
): Promise<providers.TransactionReceipt | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await throttleRpc();
      const provider = attempt === 0 ? getProvider() : rotateProvider();
      const receipt = await provider.getTransactionReceipt(txHash);
      _consecutiveErrors = 0; // Reset on success
      return receipt;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.log(`⚠️ getReceipt attempt ${attempt + 1} failed: ${lastError.message}`);
      
      const isRateLimit = handleRpcError(e);
      if (isRateLimit && attempt < maxRetries - 1) {
        // Wait for backoff then retry
        continue;
      }
    }
  }

  console.error(`❌ Failed to get receipt after ${maxRetries} attempts: ${lastError?.message}`);
  return null;
}

/**
 * Wait for transaction with timeout and rate limit handling
 */
export async function waitForTransaction(
  txHash: string,
  confirmations = 1,
  timeoutMs = 120000
): Promise<providers.TransactionReceipt | null> {
  await throttleRpc();
  const provider = getProvider();
  
  try {
    const receipt = await provider.waitForTransaction(txHash, confirmations, timeoutMs);
    _consecutiveErrors = 0;
    return receipt;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('timeout')) {
      console.log(`⏳ Transaction ${txHash} still pending after ${timeoutMs / 1000}s`);
      return null;
    }
    handleRpcError(e);
    throw e;
  }
}

/**
 * Get current nonce for address with rate limiting
 */
export async function getCurrentNonce(address: string): Promise<number> {
  await throttleRpc();
  const provider = getProvider();
  try {
    const nonce = await provider.getTransactionCount(address, 'pending');
    _consecutiveErrors = 0;
    return nonce;
  } catch (e) {
    handleRpcError(e);
    throw e;
  }
}

/**
 * Get latest block number with rate limiting
 */
export async function getBlockNumber(): Promise<number> {
  await throttleRpc();
  const provider = getProvider();
  try {
    const blockNum = await provider.getBlockNumber();
    _consecutiveErrors = 0;
    return blockNum;
  } catch (e) {
    handleRpcError(e);
    throw e;
  }
}

/**
 * Query past PayoutRedemption events for a wallet with rate limiting
 */
export async function getRecentPayoutRedemptions(
  redeemerAddress: string,
  fromBlock: number,
  toBlock: number | 'latest' = 'latest'
): Promise<PayoutRedemptionEvent[]> {
  await throttleRpc();
  const provider = getProvider();
  const iface = new ethers.utils.Interface(CTF_ABI);
  
  // PayoutRedemption has redeemer as first indexed param
  const redeemerTopic = ethers.utils.hexZeroPad(redeemerAddress.toLowerCase(), 32);

  const filter = {
    address: CTF_ADDRESS,
    topics: [PAYOUT_REDEMPTION_TOPIC, redeemerTopic],
    fromBlock,
    toBlock,
  };

  try {
    const logs = await provider.getLogs(filter);
    _consecutiveErrors = 0;
    const events: PayoutRedemptionEvent[] = [];

    for (const log of logs) {
      try {
        const parsed = iface.parseLog(log);
        const payout = parsed.args.payout as ethers.BigNumber;

        events.push({
          redeemer: parsed.args.redeemer,
          collateralToken: parsed.args.collateralToken,
          parentCollectionId: parsed.args.parentCollectionId,
          conditionId: parsed.args.conditionId,
          indexSets: parsed.args.indexSets.map((n: ethers.BigNumber) => n.toNumber()),
          payout: payout.toString(),
          payoutUSDC: parseFloat(ethers.utils.formatUnits(payout, 6)),
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
        });
      } catch {}
    }

    return events;
  } catch (e) {
    handleRpcError(e);
    console.error('❌ Failed to query PayoutRedemption events:', e);
    return [];
  }
}

// ===========================================================
// CHAINLINK PRICE FEEDS – Real-time BTC/ETH from Polygon
// ===========================================================

interface ChainlinkFeedInfo {
  address: string;
  decimals: number;
}

const CHAINLINK_FEEDS: Record<string, ChainlinkFeedInfo> = {
  BTC: { address: '0xc907E116054Ad103354f2D350FD2514433D57F6f', decimals: 8 },
  ETH: { address: '0xF9680D99D6C9589e2a93a78A04A279e509205945', decimals: 8 },
};

const AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

export interface ChainlinkPrice {
  price: number;
  timestamp: number;
}

/**
 * Fetch the latest Chainlink price for an asset (BTC or ETH).
 * Returns null if the feed is unavailable or stale.
 */
export async function fetchChainlinkPrice(asset: 'BTC' | 'ETH'): Promise<ChainlinkPrice | null> {
  const feedInfo = CHAINLINK_FEEDS[asset];
  if (!feedInfo) return null;

  try {
    await throttleRpc();
    const provider = getProvider();
    const aggregator = new ethers.Contract(feedInfo.address, AGGREGATOR_ABI, provider);
    const [, answer, , updatedAt] = await aggregator.latestRoundData();
    _consecutiveErrors = 0;
    const price = parseFloat(ethers.utils.formatUnits(answer, feedInfo.decimals));
    const timestamp = (updatedAt as ethers.BigNumber).toNumber();
    return { price, timestamp };
  } catch (e) {
    handleRpcError(e);
    console.error(`❌ fetchChainlinkPrice(${asset}) error:`, e);
    return null;
  }
}
