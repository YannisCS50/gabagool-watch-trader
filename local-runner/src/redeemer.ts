import { ethers, Wallet } from 'ethers';
import { config } from './config.js';
import {
  getProvider,
  CTF_ADDRESS,
  USDC_ADDRESS,
  parsePayoutRedemptionEvents,
  waitForTransaction,
  PayoutRedemptionEvent,
} from './chain.js';
import { reconcile, printReconciliationReport } from './reconcile.js';

// Polymarket API endpoints
const DATA_API_URL = 'https://data-api.polymarket.com';

// CTF ABI for direct redeem
const CTF_REDEEM_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
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
  negRisk?: boolean;
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
// TRACKING: Event-based confirmation
// ============================================================================

const confirmedClaims = new Map<string, {
  txHash: string;
  blockNumber: number;
  payoutUSDC: number;
  confirmedAt: number;
}>();

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

function initializeRedeemer(): void {
  if (wallet) return;

  console.log('🔧 Initializing redeemer...');

  const provider = getProvider();
  wallet = new Wallet(config.polymarket.privateKey, provider);

  const signerAddress = wallet.address.toLowerCase();
  const proxyAddress = (config.polymarket.address || '').toLowerCase();

  console.log(`✅ Redeemer initialized`);
  console.log(`   📍 Signer (EOA): ${wallet.address}`);
  console.log(`   📍 Proxy wallet (config): ${config.polymarket.address || 'not set'}`);

  // Detect wallet type
  if (!proxyAddress) {
    console.log(`\n⚠️ No POLYMARKET_ADDRESS set - will try direct EOA claiming`);
  } else if (signerAddress === proxyAddress) {
    console.log(`\n✅ Signer = Proxy (EOA mode) - direct claiming supported`);
  } else {
    console.log(`\n🔐 Signer ≠ Proxy (Proxy wallet mode)`);
    console.log(`   Will use Polymarket Relayer API for claiming`);
  }
}

function isProxyWalletMode(): boolean {
  const signerAddress = wallet?.address.toLowerCase() || '';
  const proxyAddress = (config.polymarket.address || '').toLowerCase();
  return proxyAddress !== '' && signerAddress !== proxyAddress;
}

// ============================================================================
// PROXY WALLET CLAIMING STATUS
// ============================================================================
// NOTE: As of Dec 2025, Polymarket does NOT have an official API for redeeming
// positions held by proxy wallets (Safe/Magic wallets). This is a known issue:
// - https://github.com/Polymarket/py-clob-client/issues/139
// - https://github.com/Polymarket/conditional-token-examples-py/issues/1
//
// For proxy wallets, users MUST claim via the Polymarket UI at:
// https://polymarket.com/portfolio
// ============================================================================

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
// REDEEM: Direct EOA method
// ============================================================================
async function redeemDirectEOA(position: RedeemablePosition): Promise<boolean> {
  const conditionId = position.conditionId;
  const provider = getProvider();
  const ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_REDEEM_ABI, wallet!);

  console.log(`   🔧 Using direct EOA redemption...`);

  try {
    const indexSets = [1, 2];
    const parentCollectionId = ethers.utils.hexZeroPad('0x00', 32);

    // Get gas estimate
    const feeData = await provider.getFeeData();
    const maxPriority = feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('30', 'gwei');
    const maxFee = feeData.maxFeePerGas || ethers.utils.parseUnits('60', 'gwei');

    console.log(`   ⛽ Gas: priority=${ethers.utils.formatUnits(maxPriority, 'gwei')} gwei`);

    const tx = await ctfContract.redeemPositions(
      USDC_ADDRESS,
      parentCollectionId,
      conditionId,
      indexSets,
      {
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: maxPriority,
      }
    );

    console.log(`   ⏳ Tx sent: ${tx.hash}`);

    claimTxHistory.push({
      txHash: tx.hash,
      conditionId,
      status: 'pending',
      sentAt: Date.now(),
    });

    const receipt = await waitForTransaction(tx.hash, 1, 120000);

    if (!receipt) {
      console.log(`   ⏳ Tx still pending`);
      return false;
    }

    if (receipt.status !== 1) {
      console.log(`   ❌ Tx failed on-chain`);
      return false;
    }

    const events = parsePayoutRedemptionEvents(receipt);

    if (events.length === 0) {
      console.log(`   ⚠️ Tx succeeded but no PayoutRedemption events`);
      return false;
    }

    for (const event of events) {
      console.log(`   ✅ CONFIRMED: claimed $${event.payoutUSDC.toFixed(2)}`);
      confirmedClaims.set(event.conditionId, {
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        payoutUSDC: event.payoutUSDC,
        confirmedAt: Date.now(),
      });
    }

    return true;
  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error(`   ❌ Direct redeem failed: ${msg}`);
    return false;
  }
}

// ============================================================================
// REDEEM: Proxy wallet - NOT SUPPORTED VIA API
// ============================================================================
// Polymarket does NOT currently have an official API for redeeming positions
// held by proxy wallets. This is a known limitation - see GitHub issues above.
// Users with proxy wallets (MetaMask connection) must claim via the UI.
// ============================================================================
function printProxyWalletClaimInstructions(positions: RedeemablePosition[]): void {
  const totalValue = positions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`⚠️  PROXY WALLET DETECTED - MANUAL CLAIM REQUIRED`);
  console.log(`${'='.repeat(70)}`);
  console.log(`\nYour positions are held by a proxy wallet (Safe/Magic).`);
  console.log(`Polymarket does NOT yet support automated claiming via API for proxy wallets.`);
  console.log(`\n📋 CLAIMABLE POSITIONS (${positions.length} total, $${totalValue.toFixed(2)} value):`);
  
  for (const p of positions) {
    console.log(`   💰 ${p.outcome} ${p.size.toFixed(0)} shares @ ${p.title?.slice(0, 45)}`);
    console.log(`      Value: $${p.currentValue?.toFixed(2)}`);
  }
  
  console.log(`\n🔗 TO CLAIM YOUR WINNINGS:`);
  console.log(`   1. Go to: https://polymarket.com/portfolio`);
  console.log(`   2. Connect your MetaMask wallet`);
  console.log(`   3. Click the "Claim" button on each resolved market`);
  console.log(`\n💡 TIP: Bookmark this page for easy access to claims!`);
  console.log(`${'='.repeat(70)}\n`);
}

// ============================================================================
// MAIN REDEEM FUNCTION
// ============================================================================
async function redeemPositionWithConfirmation(position: RedeemablePosition): Promise<boolean> {
  const conditionId = position.conditionId;

  console.log(`\n💎 CLAIMING: ${position.title?.slice(0, 50)}`);
  console.log(`   Outcome: ${position.outcome} | Value: $${position.currentValue?.toFixed(2)}`);
  console.log(`   ConditionId: ${conditionId}`);
  console.log(`   Position wallet: ${position.proxyWallet}`);
  console.log(`   Signer wallet: ${wallet?.address}`);

  // Only EOA (direct) mode is supported for automated claims
  if (isProxyWalletMode()) {
    console.log(`   ⚠️ Proxy wallet mode - automated claiming not available`);
    return false;
  } else {
    return redeemDirectEOA(position);
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================
export async function checkAndClaimWinnings(): Promise<{ claimed: number; total: number }> {
  if (!await acquireClaimMutex()) {
    return { claimed: 0, total: 0 };
  }

  try {
    initializeRedeemer();

    const positions = await fetchRedeemablePositions();

    if (positions.length === 0) {
      return { claimed: 0, total: 0 };
    }

    // If proxy wallet mode, show instructions and exit
    if (isProxyWalletMode()) {
      printProxyWalletClaimInstructions(positions);
      console.log(`\n📊 RESULT: ${positions.length} positions need manual claiming`);
      return { claimed: 0, total: positions.length };
    }

    // EOA mode - attempt automated claiming
    let claimedCount = 0;

    for (const position of positions) {
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

      // POST-CLAIM VERIFICATION
      console.log(`\n🔄 Verifying claims...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const remainingPositions = await fetchRedeemablePositions();
      if (remainingPositions.length > 0) {
        console.log(`⚠️ ${remainingPositions.length} positions still showing as claimable`);
        console.log(`   This may be due to indexer delay`);
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
export function getConfirmedClaims(): Map<string, any> {
  return new Map(confirmedClaims);
}

/**
 * Print debug state
 */
export function printDebugState(): void {
  console.log('\n📊 REDEEMER DEBUG STATE:');
  console.log(`   Confirmed claims: ${confirmedClaims.size}`);
  console.log(`   Tx history entries: ${claimTxHistory.length}`);
  console.log(`   Proxy wallet mode: ${isProxyWalletMode()}`);
  
  if (confirmedClaims.size > 0) {
    console.log('\n   Confirmed claims:');
    for (const [conditionId, claim] of confirmedClaims) {
      console.log(`   - ${conditionId.slice(0, 20)}...: $${claim.payoutUSDC.toFixed(2)} (block ${claim.blockNumber})`);
    }
  }
}
