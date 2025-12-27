import { ethers, Contract, Wallet, providers } from 'ethers';
import { config } from './config.js';

// Polygon RPC endpoint
const POLYGON_RPC = 'https://polygon-rpc.com';

// Polymarket Data API endpoint
const DATA_API_URL = 'https://data-api.polymarket.com';

// Conditional Tokens Framework (CTF) contract on Polygon
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// USDC address on Polygon (collateral token)
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Minimal ABI for ConditionalTokens redeemPositions function
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
  'event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)',
];

// Interface for redeemable position from Polymarket API
interface RedeemablePosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  redeemable: boolean;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
}

// Track claimed / in-flight condition IDs to avoid duplicate claims
const claimedConditions = new Set<string>();
const inFlightConditions = new Set<string>();
// Provider and wallet instances
let provider: providers.JsonRpcProvider | null = null;
let wallet: Wallet | null = null;
let ctfContract: Contract | null = null;

/**
 * Initialize the redeemer with provider and wallet
 */
function initializeRedeemer(): void {
  if (wallet) return; // Already initialized

  console.log('🔧 Initializing redeemer...');
  
  provider = new providers.JsonRpcProvider(POLYGON_RPC);
  wallet = new Wallet(config.polymarket.privateKey, provider);
  ctfContract = new Contract(CTF_ADDRESS, CTF_ABI, wallet);
  
  console.log(`✅ Redeemer initialized with address: ${wallet.address}`);
}

/**
 * Fetch all redeemable positions from Polymarket Data API
 */
async function fetchRedeemablePositions(): Promise<RedeemablePosition[]> {
  try {
    // Use the Polymarket Safe proxy wallet address
    const walletAddress = config.polymarket.address;
    
    console.log(`🔍 Checking redeemable positions for wallet: ${walletAddress}`);
    
    const url = `${DATA_API_URL}/positions?user=${walletAddress}&sizeThreshold=0&limit=100`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`❌ Failed to fetch positions: HTTP ${response.status}`);
      console.error(`   Response: ${body.slice(0, 200)}`);
      return [];
    }

    const positions: RedeemablePosition[] = await response.json();
    
    console.log(`📊 Found ${positions.length} total positions`);
    
    // Log all positions for debugging
    for (const p of positions) {
      const status = p.redeemable ? '💰 REDEEMABLE' : '⏳ not yet';
      console.log(`   ${status}: ${p.outcome} ${p.size.toFixed(0)} shares @ ${p.title?.slice(0, 40) || p.slug}`);
    }
    
    // Filter for redeemable positions only
    const redeemable = positions.filter(p => p.redeemable === true);
    
    if (redeemable.length > 0) {
      console.log(`\n💰 ${redeemable.length} positions ready to claim!`);
    } else {
      console.log(`   No redeemable positions at this time`);
    }
    
    return redeemable;
  } catch (error) {
    console.error('❌ Error fetching redeemable positions:', error);
    return [];
  }
}

/**
 * Redeem a single position by calling the CTF contract
 */
async function redeemPosition(position: RedeemablePosition): Promise<boolean> {
  if (!wallet || !ctfContract) {
    initializeRedeemer();
  }

  const conditionId = position.conditionId;
  
  // Skip if already claimed or already being processed
  if (claimedConditions.has(conditionId) || inFlightConditions.has(conditionId)) {
    return false;
  }

  inFlightConditions.add(conditionId);

  console.log(`\n💎 CLAIMING WINNINGS`);
  console.log(`   Market: ${position.title}`);
  console.log(`   Outcome: ${position.outcome}`);
  console.log(`   Value: $${position.currentValue.toFixed(2)}`);
  console.log(`   P&L: $${position.cashPnl.toFixed(2)}`);
  console.log(`   Condition ID: ${conditionId}`);

  try {
    // For Polymarket binary markets, we need index sets [1, 2] for both outcomes
    // outcomeIndex 0 = YES/UP = index set 1 (binary 01)
    // outcomeIndex 1 = NO/DOWN = index set 2 (binary 10)
    const indexSets = [1, 2]; // Redeem both outcome slots
    
    // Parent collection ID is zero for top-level conditions
    const parentCollectionId = ethers.utils.hexZeroPad('0x00', 32);

    console.log(`   📤 REDEEM: sending redeemPositions transaction...`);
    
    const tx = await ctfContract!.redeemPositions(
      USDC_ADDRESS,
      parentCollectionId,
      conditionId,
      indexSets
    );

    console.log(`   ⏳ REDEEM: tx sent ${tx.hash}`);
    
    // Wait for confirmation
    const receipt = await tx.wait(1);
    
    if (receipt.status === 1) {
      console.log(`   ✅ REDEEM: claimed in block ${receipt.blockNumber}`);
      claimedConditions.add(conditionId);
      return true;
    } else {
      console.error(`   ❌ REDEEM: transaction failed`);
      return false;
    }
  } catch (error: any) {
    const msg = error?.message || String(error);

    // Check for common errors
    if (msg.includes('result for condition not received yet')) {
      console.log(`   ⏳ REDEEM: market not yet resolved, skipping...`);
    } else if (msg.includes('insufficient funds')) {
      console.error(`   ❌ REDEEM: insufficient gas funds for transaction`);
    } else if (msg.includes('execution reverted')) {
      console.log(`   ⚠️ REDEEM: execution reverted (already claimed / not resolved / wrong wallet)`);
      // Mark as claimed to avoid repeated attempts this session
      claimedConditions.add(conditionId);
    } else {
      console.error(`   ❌ REDEEM: claim failed: ${msg}`);
    }

    return false;
  } finally {
    inFlightConditions.delete(conditionId);
  }
}

/**
 * Main function to check and claim all redeemable positions
 */
export async function checkAndClaimWinnings(): Promise<{ claimed: number; total: number }> {
  initializeRedeemer();
  
  const positions = await fetchRedeemablePositions();
  
  if (positions.length === 0) {
    return { claimed: 0, total: 0 };
  }

  let claimedCount = 0;
  
  for (const position of positions) {
    // Skip positions we already tried to claim
    if (claimedConditions.has(position.conditionId)) {
      continue;
    }
    
    // Small delay between claims to avoid rate limiting
    if (claimedCount > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    const success = await redeemPosition(position);
    if (success) {
      claimedCount++;
    }
  }

  if (claimedCount > 0) {
    console.log(`\n🎉 Claimed ${claimedCount} of ${positions.length} redeemable positions`);
  }

  return { claimed: claimedCount, total: positions.length };
}

/**
 * Get current claimable value from API
 */
export async function getClaimableValue(): Promise<number> {
  const positions = await fetchRedeemablePositions();
  return positions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
}
