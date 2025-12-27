import { ethers, providers } from 'ethers';

// Polygon RPC endpoints (fallback list)
const RPC_ENDPOINTS = [
  'https://polygon-rpc.com',
  'https://rpc-mainnet.matic.quiknode.pro',
  'https://polygon-mainnet.public.blastapi.io',
];

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
 * Get transaction receipt with retry
 */
export async function getReceiptWithRetry(
  txHash: string,
  maxRetries = 3
): Promise<providers.TransactionReceipt | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const provider = attempt === 0 ? getProvider() : rotateProvider();
      const receipt = await provider.getTransactionReceipt(txHash);
      return receipt;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.log(`⚠️ getReceipt attempt ${attempt + 1} failed: ${lastError.message}`);
    }
  }

  console.error(`❌ Failed to get receipt after ${maxRetries} attempts: ${lastError?.message}`);
  return null;
}

/**
 * Wait for transaction with timeout
 */
export async function waitForTransaction(
  txHash: string,
  confirmations = 1,
  timeoutMs = 120000
): Promise<providers.TransactionReceipt | null> {
  const provider = getProvider();
  
  try {
    const receipt = await provider.waitForTransaction(txHash, confirmations, timeoutMs);
    return receipt;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('timeout')) {
      console.log(`⏳ Transaction ${txHash} still pending after ${timeoutMs / 1000}s`);
      return null;
    }
    throw e;
  }
}

/**
 * Get current nonce for address
 */
export async function getCurrentNonce(address: string): Promise<number> {
  const provider = getProvider();
  return provider.getTransactionCount(address, 'pending');
}

/**
 * Get latest block number
 */
export async function getBlockNumber(): Promise<number> {
  const provider = getProvider();
  return provider.getBlockNumber();
}

/**
 * Query past PayoutRedemption events for a wallet
 */
export async function getRecentPayoutRedemptions(
  redeemerAddress: string,
  fromBlock: number,
  toBlock: number | 'latest' = 'latest'
): Promise<PayoutRedemptionEvent[]> {
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
    console.error('❌ Failed to query PayoutRedemption events:', e);
    return [];
  }
}
