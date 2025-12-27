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

// Track pending on-chain tx per condition (prevents "stuck claiming" loops)
const pendingTxByCondition = new Map<string, { hash: string; sentAtMs: number }>();

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

async function getRedeemGasOverrides(): Promise<
  | { maxFeePerGas: ethers.BigNumber; maxPriorityFeePerGas: ethers.BigNumber }
  | undefined
> {
  if (!provider) return;

  const floorPriority = ethers.utils.parseUnits('30', 'gwei');
  const floorMaxFee = ethers.utils.parseUnits('60', 'gwei');

  try {
    const feeData = await provider.getFeeData();

    let maxPriority = feeData.maxPriorityFeePerGas || feeData.gasPrice || floorPriority;
    if (maxPriority.lt(floorPriority)) maxPriority = floorPriority;

    let maxFee = feeData.maxFeePerGas || feeData.gasPrice || floorMaxFee;
    if (maxFee.lt(floorMaxFee)) maxFee = floorMaxFee;

    if (maxFee.lt(maxPriority.mul(2))) {
      maxFee = maxPriority.mul(2);
    }

    console.log(
      `⛽ Redeem gas: priority=${ethers.utils.formatUnits(maxPriority, 'gwei')} gwei, max=${ethers.utils.formatUnits(maxFee, 'gwei')} gwei`
    );

    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority };
  } catch (e: any) {
    console.log(
      `⚠️ Failed to fetch fee data, using floor gas settings: ${e?.message || e}`
    );
    return { maxFeePerGas: floorMaxFee, maxPriorityFeePerGas: floorPriority };
  }
}
async function refreshPendingTx(
  conditionId: string
): Promise<'none' | 'pending' | 'mined' | 'failed'> {
  const pending = pendingTxByCondition.get(conditionId);
  if (!pending) return 'none';

  // Give the tx some time to be indexed/mined before allowing retries
  const ageMs = Date.now() - pending.sentAtMs;
  const maxPendingMs = 10 * 60 * 1000; // 10 minutes

  if (!provider) return 'pending';

  try {
    const receipt = await provider.getTransactionReceipt(pending.hash);

    if (!receipt) {
      if (ageMs > maxPendingMs) {
        console.log(
          `   ⚠️ REDEEM: tx ${pending.hash} still missing after 10m; allowing retry for condition ${conditionId}`
        );
        pendingTxByCondition.delete(conditionId);
        return 'failed';
      }

      return 'pending';
    }

    // Mined
    pendingTxByCondition.delete(conditionId);

    if (receipt.status === 1) {
      console.log(`   ✅ REDEEM: confirmed ${pending.hash} in block ${receipt.blockNumber}`);
      claimedConditions.add(conditionId);
      return 'mined';
    }

    console.log(`   ❌ REDEEM: tx ${pending.hash} failed on-chain (status=0)`);
    return 'failed';
  } catch (e: any) {
    // Don't crash claiming loop on transient RPC errors
    console.log(`   ⚠️ REDEEM: failed to check tx ${pending.hash}: ${e?.message || e}`);
    return 'pending';
  }
}

/**
 * Fetch all redeemable positions from Polymarket Data API for BOTH wallets
 * (signing wallet + configured proxy wallet)
 */
async function fetchRedeemablePositions(): Promise<RedeemablePosition[]> {
  // Get both wallet addresses
  const proxyWallet = config.polymarket.address;
  const signingWallet = wallet?.address;

  const walletsToCheck = new Set<string>();
  if (proxyWallet) walletsToCheck.add(proxyWallet.toLowerCase());
  if (signingWallet) walletsToCheck.add(signingWallet.toLowerCase());

  console.log(`🔍 Checking redeemable positions for ${walletsToCheck.size} wallet(s):`);
  for (const w of walletsToCheck) {
    console.log(`   📍 ${w}`);
  }

  const allPositions: RedeemablePosition[] = [];

  for (const walletAddress of walletsToCheck) {
    let cursor: string | null = null;
    let pageCount = 0;
    const maxPages = 10; // Safety limit

    try {
      while (pageCount < maxPages) {
        pageCount++;
        let url = `${DATA_API_URL}/positions?user=${walletAddress}&sizeThreshold=0&limit=500`;
        if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        });

        if (!response.ok) {
          const body = await response.text();
          console.error(`❌ Failed to fetch positions for ${walletAddress}: HTTP ${response.status}`);
          console.error(`   Response: ${body.slice(0, 200)}`);
          break;
        }

        const data = await response.json();
        
        // Handle both array response and paginated object response
        let positions: RedeemablePosition[];
        let nextCursor: string | null = null;
        
        if (Array.isArray(data)) {
          positions = data;
        } else if (data.positions && Array.isArray(data.positions)) {
          positions = data.positions;
          nextCursor = data.next_cursor || data.nextCursor || null;
        } else {
          console.log(`   ⚠️ Unexpected API response format for ${walletAddress}`);
          break;
        }

        allPositions.push(...positions);
        console.log(`   📄 Page ${pageCount}: ${positions.length} positions for ${walletAddress.slice(0,10)}...`);

        // Stop if no more pages or same cursor returned
        if (!nextCursor || nextCursor === cursor || positions.length === 0) break;
        cursor = nextCursor;
      }

    } catch (error) {
      console.error(`❌ Error fetching positions for ${walletAddress}:`, error);
    }
  }

  console.log(`📊 Total positions fetched: ${allPositions.length}`);

  // Filter for redeemable positions only, exclude already-claimed and pending-tx ones,
  // and de-dupe by conditionId (binary markets often return both UP and DOWN entries).
  const redeemableByCondition = new Map<string, RedeemablePosition>();

  for (const p of allPositions) {
    if (!p.redeemable) continue;
    if (claimedConditions.has(p.conditionId)) continue;
    if (pendingTxByCondition.has(p.conditionId)) continue;

    const existing = redeemableByCondition.get(p.conditionId);
    // Keep the larger currentValue entry for nicer logging (functionality is same)
    if (!existing || (p.currentValue || 0) > (existing.currentValue || 0)) {
      redeemableByCondition.set(p.conditionId, p);
    }
  }

  const redeemable = [...redeemableByCondition.values()];

  // Only log positions that are actually still pending
  if (redeemable.length > 0) {
    console.log(
      `💰 Found ${redeemable.length} redeemable conditions (skipping ${claimedConditions.size} claimed, ${pendingTxByCondition.size} pending-tx):`
    );
    for (const p of redeemable) {
      console.log(
        `   💰 REDEEMABLE: ${p.outcome} ${p.size.toFixed(0)} shares @ ${p.title?.slice(0, 50) || p.slug} [${p.proxyWallet?.slice(0,10)}...]`
      );
    }
  } else if (pendingTxByCondition.size > 0) {
    console.log(`   ⏳ Claims pending on-chain (${pendingTxByCondition.size} tx), waiting...`);
  } else if (claimedConditions.size > 0) {
    console.log(`   ✅ All positions already claimed this session (${claimedConditions.size} total)`);
  } else {
    console.log(`   No redeemable positions at this time`);
  }

  return redeemable;
}

/**
 * Redeem a single position by calling the CTF contract
 */
async function redeemPosition(position: RedeemablePosition): Promise<boolean> {
  if (!wallet || !ctfContract) {
    initializeRedeemer();
  }

  const conditionId = position.conditionId;
  
  // If we already sent a tx for this condition, re-check its receipt first.
  const pendingState = await refreshPendingTx(conditionId);
  if (pendingState === 'pending') return false;

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

    const overrides = await getRedeemGasOverrides();

    let tx;
    try {
      tx = await ctfContract!.redeemPositions(
        USDC_ADDRESS,
        parentCollectionId,
        conditionId,
        indexSets,
        overrides
      );
    } catch (error: any) {
      const msg = error?.message || String(error);

      // Public RPC often rejects low tip caps; bump gas and retry once
      if (msg.includes('gas price below minimum') || msg.includes('tip cap')) {
        const bumped = {
          maxPriorityFeePerGas: ethers.utils.parseUnits('40', 'gwei'),
          maxFeePerGas: ethers.utils.parseUnits('100', 'gwei'),
        };

        console.log(
          `   ⛽ REDEEM: gas too low for RPC, retrying with priority=40 gwei / max=100 gwei`
        );

        tx = await ctfContract!.redeemPositions(
          USDC_ADDRESS,
          parentCollectionId,
          conditionId,
          indexSets,
          bumped
        );
      } else {
        throw error;
      }
    }

    console.log(`   ⏳ REDEEM: tx sent ${tx.hash}`);

    pendingTxByCondition.set(conditionId, { hash: tx.hash, sentAtMs: Date.now() });

    // Wait for confirmation (with timeout). If it stays pending, we will re-check next tick.
    let receipt: ethers.providers.TransactionReceipt;
    try {
      if (provider) {
        receipt = await provider.waitForTransaction(tx.hash, 1, 120_000);
      } else {
        receipt = await tx.wait(1);
      }
    } catch (e: any) {
      const msg = (e?.message || String(e)).toLowerCase();
      if (msg.includes('timeout')) {
        console.log(`   ⏳ REDEEM: tx still pending after 120s, will re-check next tick`);
        return false;
      }
      throw e;
    }

    // tx mined -> no longer pending
    pendingTxByCondition.delete(conditionId);
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
