import { ethers, Contract, Wallet, providers } from 'ethers';
import { config } from './config.js';
import {
  getProvider,
  rotateProvider,
  CTF_ADDRESS,
  USDC_ADDRESS,
  CTF_ABI,
  parsePayoutRedemptionEvents,
  waitForTransaction,
  getCurrentNonce,
  PayoutRedemptionEvent,
} from './chain.js';
import { reconcile, printReconciliationReport } from './reconcile.js';

// Polymarket Data API endpoint
const DATA_API_URL = 'https://data-api.polymarket.com';

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

// ============================================================================
// MUTEX: Prevent concurrent claim loops
// ============================================================================
let claimMutexLocked = false;

async function acquireClaimMutex(): Promise<boolean> {
  if (claimMutexLocked) {
    console.log('🔒 Claim mutex already held, skipping');
    return false;
  }
  claimMutexLocked = true;
  return true;
}

function releaseClaimMutex(): void {
  claimMutexLocked = false;
}

// ============================================================================
// NONCE MANAGER: Prevent nonce conflicts
// ============================================================================
let currentNonce: number | null = null;
let nonceRefreshTimestamp = 0;

async function getNextNonce(wallet: Wallet): Promise<number> {
  const now = Date.now();
  
  // Refresh nonce from chain every 30 seconds or if never fetched
  if (currentNonce === null || now - nonceRefreshTimestamp > 30000) {
    currentNonce = await getCurrentNonce(wallet.address);
    nonceRefreshTimestamp = now;
    console.log(`🔢 Nonce refreshed from chain: ${currentNonce}`);
  }
  
  const nonce = currentNonce!;
  currentNonce! += 1;
  return nonce;
}

async function resetNonce(wallet: Wallet): Promise<void> {
  currentNonce = await getCurrentNonce(wallet.address);
  nonceRefreshTimestamp = Date.now();
  console.log(`🔢 Nonce reset to: ${currentNonce}`);
}

// ============================================================================
// TRACKING: Event-based confirmation
// ============================================================================

// Track confirmed claims by conditionId (only after on-chain event confirmation)
const confirmedClaims = new Map<string, {
  txHash: string;
  blockNumber: number;
  payoutUSDC: number;
  confirmedAt: number;
}>();

// Track pending transactions
const pendingTransactions = new Map<string, {
  conditionId: string;
  sentAt: number;
  nonce: number;
}>();

// Track tx hashes for reconciliation
const claimTxHistory: Array<{
  txHash: string;
  conditionId: string;
  status: 'pending' | 'confirmed' | 'failed';
  sentAt: number;
  confirmedAt?: number;
}> = [];

// ============================================================================
// INITIALIZATION
// ============================================================================
let wallet: Wallet | null = null;
let ctfContract: Contract | null = null;

function initializeRedeemer(): void {
  if (wallet) return;

  console.log('🔧 Initializing redeemer...');

  const provider = getProvider();
  wallet = new Wallet(config.polymarket.privateKey, provider);
  ctfContract = new Contract(CTF_ADDRESS, CTF_ABI, wallet);

  const signerAddress = wallet.address.toLowerCase();
  const proxyAddress = (config.polymarket.address || '').toLowerCase();

  console.log(`✅ Redeemer initialized`);
  console.log(`   📍 Signer (EOA): ${wallet.address}`);
  console.log(`   📍 Proxy wallet (config): ${config.polymarket.address || 'not set'}`);

  // CRITICAL: Check if signer matches proxy wallet
  if (proxyAddress && signerAddress !== proxyAddress) {
    console.error('\n' + '⚠️'.repeat(30));
    console.error('🚨 CRITICAL WALLET MISMATCH DETECTED!');
    console.error('='.repeat(60));
    console.error(`   Your POLYMARKET_PRIVATE_KEY resolves to: ${wallet.address}`);
    console.error(`   Your POLYMARKET_ADDRESS is set to:       ${config.polymarket.address}`);
    console.error('');
    console.error('   These addresses DO NOT MATCH!');
    console.error('');
    console.error('   CTF redeemPositions() only works for msg.sender.');
    console.error('   If positions are held by POLYMARKET_ADDRESS but you sign');
    console.error('   with a different key, claims will silently fail (0 events).');
    console.error('');
    console.error('   FIX: Update your .env so that:');
    console.error('   - POLYMARKET_PRIVATE_KEY is the private key of the wallet');
    console.error('     that actually holds the CTF position tokens');
    console.error('   - OR set POLYMARKET_ADDRESS to match your signer address');
    console.error('='.repeat(60));
    console.error('⚠️'.repeat(30) + '\n');
    
    throw new Error(
      `Signer mismatch: POLYMARKET_ADDRESS=${config.polymarket.address} but PRIVATE_KEY resolves to ${wallet.address}. ` +
      `You can only redeem from the address that holds the position tokens (msg.sender).`
    );
  }
}

// ============================================================================
// GAS ESTIMATION
// ============================================================================
async function getRedeemGasOverrides(): Promise<{
  maxFeePerGas: ethers.BigNumber;
  maxPriorityFeePerGas: ethers.BigNumber;
  nonce: number;
}> {
  const provider = getProvider();

  const floorPriority = ethers.utils.parseUnits('30', 'gwei');
  const floorMaxFee = ethers.utils.parseUnits('60', 'gwei');

  let maxPriority = floorPriority;
  let maxFee = floorMaxFee;

  try {
    const feeData = await provider.getFeeData();
    maxPriority = feeData.maxPriorityFeePerGas || feeData.gasPrice || floorPriority;
    if (maxPriority.lt(floorPriority)) maxPriority = floorPriority;

    maxFee = feeData.maxFeePerGas || feeData.gasPrice || floorMaxFee;
    if (maxFee.lt(floorMaxFee)) maxFee = floorMaxFee;
    if (maxFee.lt(maxPriority.mul(2))) maxFee = maxPriority.mul(2);
  } catch (e) {
    console.log('⚠️ Using floor gas settings');
  }

  const nonce = await getNextNonce(wallet!);

  console.log(
    `⛽ Gas: priority=${ethers.utils.formatUnits(maxPriority, 'gwei')} gwei, max=${ethers.utils.formatUnits(maxFee, 'gwei')} gwei, nonce=${nonce}`
  );

  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority, nonce };
}

// ============================================================================
// FETCH POSITIONS
// ============================================================================
async function fetchRedeemablePositions(): Promise<RedeemablePosition[]> {
  const proxyWallet = config.polymarket.address;
  const signingWallet = wallet?.address;

  const walletsToCheck = new Set<string>();
  if (proxyWallet) walletsToCheck.add(proxyWallet.toLowerCase());
  if (signingWallet) walletsToCheck.add(signingWallet.toLowerCase());

  console.log(`\n🔍 Fetching positions for ${walletsToCheck.size} wallet(s):`);
  for (const w of walletsToCheck) {
    console.log(`   📍 ${w}`);
  }

  const allPositions: RedeemablePosition[] = [];

  for (const walletAddress of walletsToCheck) {
    let cursor: string | null = null;
    let pageCount = 0;
    const maxPages = 10;

    try {
      while (pageCount < maxPages) {
        pageCount++;
        let url = `${DATA_API_URL}/positions?user=${walletAddress}&sizeThreshold=0&limit=500`;
        if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
          console.error(`❌ API error for ${walletAddress}: HTTP ${response.status}`);
          break;
        }

        const data = await response.json();

        let positions: RedeemablePosition[];
        let nextCursor: string | null = null;

        if (Array.isArray(data)) {
          positions = data;
        } else if (data.positions && Array.isArray(data.positions)) {
          positions = data.positions;
          nextCursor = data.next_cursor || data.nextCursor || null;
        } else {
          console.log(`⚠️ Unexpected API response for ${walletAddress}`);
          break;
        }

        // Tag each position with its wallet
        for (const p of positions) {
          p.proxyWallet = p.proxyWallet || walletAddress;
        }

        allPositions.push(...positions);
        console.log(`   📄 Page ${pageCount}: ${positions.length} positions for ${walletAddress.slice(0, 10)}...`);

        if (!nextCursor || nextCursor === cursor || positions.length === 0) break;
        cursor = nextCursor;
      }
    } catch (error) {
      console.error(`❌ Error fetching positions for ${walletAddress}:`, error);
    }
  }

  console.log(`📊 Total positions fetched: ${allPositions.length}`);

  // Filter redeemable, exclude confirmed claims
  const redeemableByCondition = new Map<string, RedeemablePosition>();

  for (const p of allPositions) {
    if (!p.redeemable) continue;
    if (confirmedClaims.has(p.conditionId)) continue;

    const existing = redeemableByCondition.get(p.conditionId);
    if (!existing || (p.currentValue || 0) > (existing.currentValue || 0)) {
      redeemableByCondition.set(p.conditionId, p);
    }
  }

  const redeemable = [...redeemableByCondition.values()];

  if (redeemable.length > 0) {
    console.log(`\n💰 ${redeemable.length} redeemable (skipping ${confirmedClaims.size} confirmed):`);
    for (const p of redeemable) {
      console.log(`   💰 ${p.outcome} ${p.size.toFixed(0)} shares @ ${p.title?.slice(0, 50)}`);
      console.log(`      Value: $${p.currentValue?.toFixed(2)} | Wallet: ${p.proxyWallet?.slice(0, 10)}...`);
    }
  } else if (confirmedClaims.size > 0) {
    console.log(`   ✅ All positions confirmed claimed (${confirmedClaims.size} total)`);
  } else {
    console.log(`   No redeemable positions`);
  }

  return redeemable;
}

// ============================================================================
// REDEEM WITH EVENT CONFIRMATION
// ============================================================================
async function redeemPositionWithConfirmation(position: RedeemablePosition): Promise<boolean> {
  const conditionId = position.conditionId;

  console.log(`\n💎 CLAIMING: ${position.title?.slice(0, 50)}`);
  console.log(`   Outcome: ${position.outcome} | Value: $${position.currentValue?.toFixed(2)}`);
  console.log(`   ConditionId: ${conditionId}`);
  console.log(`   Position wallet: ${position.proxyWallet}`);
  console.log(`   Signer wallet: ${wallet?.address}`);

  try {
    const indexSets = [1, 2];
    const parentCollectionId = ethers.utils.hexZeroPad('0x00', 32);

    const overrides = await getRedeemGasOverrides();

    console.log(`   📤 Sending redeemPositions tx (nonce=${overrides.nonce})...`);

    let tx: ethers.ContractTransaction;
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

      // Handle nonce errors
      if (msg.includes('nonce') || msg.includes('NONCE')) {
        console.log(`   🔢 Nonce error, resetting...`);
        await resetNonce(wallet!);
        
        // Retry with fresh nonce
        const newOverrides = await getRedeemGasOverrides();
        tx = await ctfContract!.redeemPositions(
          USDC_ADDRESS,
          parentCollectionId,
          conditionId,
          indexSets,
          newOverrides
        );
      } else if (msg.includes('gas price below minimum') || msg.includes('tip cap')) {
        // Bump gas
        console.log(`   ⛽ Gas too low, bumping...`);
        const bumpedOverrides = {
          ...overrides,
          maxPriorityFeePerGas: ethers.utils.parseUnits('50', 'gwei'),
          maxFeePerGas: ethers.utils.parseUnits('120', 'gwei'),
        };
        tx = await ctfContract!.redeemPositions(
          USDC_ADDRESS,
          parentCollectionId,
          conditionId,
          indexSets,
          bumpedOverrides
        );
      } else {
        throw error;
      }
    }

    console.log(`   ⏳ Tx sent: ${tx.hash}`);

    // Track pending
    pendingTransactions.set(tx.hash, {
      conditionId,
      sentAt: Date.now(),
      nonce: overrides.nonce,
    });

    claimTxHistory.push({
      txHash: tx.hash,
      conditionId,
      status: 'pending',
      sentAt: Date.now(),
    });

    // Wait for confirmation
    const receipt = await waitForTransaction(tx.hash, 1, 120000);

    if (!receipt) {
      console.log(`   ⏳ Tx still pending, will re-check later`);
      return false;
    }

    pendingTransactions.delete(tx.hash);

    if (receipt.status !== 1) {
      console.log(`   ❌ Tx failed on-chain (status=0)`);
      
      const historyEntry = claimTxHistory.find(h => h.txHash === tx.hash);
      if (historyEntry) historyEntry.status = 'failed';
      
      return false;
    }

    // PARSE EVENTS - This is the source of truth!
    const events = parsePayoutRedemptionEvents(receipt);

    if (events.length === 0) {
      console.log(`   ⚠️ Tx succeeded but no PayoutRedemption events found`);
      console.log(`      This may indicate the position was already claimed or wrong wallet`);
      return false;
    }

    // Mark as confirmed
    for (const event of events) {
      console.log(`   ✅ CONFIRMED: claimed $${event.payoutUSDC.toFixed(2)} in block ${event.blockNumber}`);
      console.log(`      ConditionId: ${event.conditionId}`);

      confirmedClaims.set(event.conditionId, {
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        payoutUSDC: event.payoutUSDC,
        confirmedAt: Date.now(),
      });

      const historyEntry = claimTxHistory.find(h => h.txHash === tx.hash);
      if (historyEntry) {
        historyEntry.status = 'confirmed';
        historyEntry.confirmedAt = Date.now();
      }
    }

    return true;
  } catch (error: any) {
    const msg = error?.message || String(error);

    if (msg.includes('result for condition not received yet')) {
      console.log(`   ⏳ Market not yet resolved, skipping`);
    } else if (msg.includes('insufficient funds')) {
      console.error(`   ❌ Insufficient gas funds`);
    } else if (msg.includes('execution reverted')) {
      console.log(`   ⚠️ Execution reverted (already claimed / not resolved / wrong wallet)`);
      // Mark as "confirmed" to stop retrying
      confirmedClaims.set(conditionId, {
        txHash: '',
        blockNumber: 0,
        payoutUSDC: 0,
        confirmedAt: Date.now(),
      });
    } else {
      console.error(`   ❌ Claim failed: ${msg}`);
    }

    return false;
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================
export async function checkAndClaimWinnings(): Promise<{ claimed: number; total: number }> {
  // Acquire mutex
  if (!await acquireClaimMutex()) {
    return { claimed: 0, total: 0 };
  }

  try {
    initializeRedeemer();

    const positions = await fetchRedeemablePositions();

    if (positions.length === 0) {
      return { claimed: 0, total: 0 };
    }

    let claimedCount = 0;

    for (const position of positions) {
      // Skip if already confirmed
      if (confirmedClaims.has(position.conditionId)) continue;

      // Delay between claims
      if (claimedCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      const success = await redeemPositionWithConfirmation(position);
      if (success) claimedCount++;
    }

    if (claimedCount > 0) {
      console.log(`\n🎉 Claimed ${claimedCount} of ${positions.length} positions`);

      // POST-CLAIM VERIFICATION: Re-fetch and compare
      console.log(`\n🔄 Verifying claims...`);
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for indexer
      
      const remainingPositions = await fetchRedeemablePositions();
      if (remainingPositions.length > 0) {
        console.log(`⚠️ ${remainingPositions.length} positions still showing as claimable`);
        console.log(`   This may be due to indexer delay or positions on different wallets`);
      } else {
        console.log(`✅ Verified: all positions claimed`);
      }
    }

    return { claimed: claimedCount, total: positions.length };
  } finally {
    releaseClaimMutex();
  }
}

/**
 * Get current claimable value from API
 */
export async function getClaimableValue(): Promise<number> {
  initializeRedeemer();
  const positions = await fetchRedeemablePositions();
  return positions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
}

/**
 * Run reconciliation and print report
 */
export async function runReconciliation(): Promise<void> {
  initializeRedeemer();
  const result = await reconcile(wallet!.address);
  printReconciliationReport(result);
}

/**
 * Get claim history for debugging
 */
export function getClaimHistory(): typeof claimTxHistory {
  return [...claimTxHistory];
}

/**
 * Get confirmed claims
 */
export function getConfirmedClaims(): Map<string, { txHash: string; blockNumber: number; payoutUSDC: number }> {
  return new Map(confirmedClaims);
}

/**
 * Debug: print current state
 */
export function printDebugState(): void {
  console.log('\n' + '='.repeat(60));
  console.log('REDEEMER DEBUG STATE');
  console.log('='.repeat(60));

  console.log(`\n📍 Wallets:`);
  console.log(`   Signer: ${wallet?.address || 'not initialized'}`);
  console.log(`   Proxy: ${config.polymarket.address || 'not set'}`);

  console.log(`\n🔢 Nonce: ${currentNonce ?? 'not set'} (last refresh: ${new Date(nonceRefreshTimestamp).toISOString()})`);
  console.log(`🔒 Mutex: ${claimMutexLocked ? 'LOCKED' : 'unlocked'}`);

  console.log(`\n✅ Confirmed claims: ${confirmedClaims.size}`);
  for (const [conditionId, claim] of confirmedClaims) {
    console.log(`   • ${conditionId.slice(0, 20)}... | $${claim.payoutUSDC.toFixed(2)} | block ${claim.blockNumber}`);
  }

  console.log(`\n⏳ Pending txs: ${pendingTransactions.size}`);
  for (const [txHash, pending] of pendingTransactions) {
    console.log(`   • ${txHash.slice(0, 20)}... | nonce ${pending.nonce} | ${Date.now() - pending.sentAt}ms ago`);
  }

  console.log(`\n📜 Tx history: ${claimTxHistory.length} entries`);
  for (const entry of claimTxHistory.slice(-10)) {
    console.log(`   • ${entry.txHash.slice(0, 20)}... | ${entry.status} | ${entry.conditionId.slice(0, 20)}...`);
  }

  console.log('\n' + '='.repeat(60));
}
