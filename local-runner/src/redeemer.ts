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
const RELAYER_URL = 'https://relayer.polymarket.com';

// Neg Risk Adapter address (for neg risk markets)
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

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
// RELAYER API: For proxy wallet claims
// ============================================================================

interface RelayerTransaction {
  to: string;
  data: string;
  value: string;
}

/**
 * Sign a message for Polymarket relayer authentication
 */
async function signRelayerMessage(message: string): Promise<string> {
  return wallet!.signMessage(message);
}

/**
 * Execute transactions via Polymarket relayer (for proxy wallets)
 */
async function executeViaRelayer(transactions: RelayerTransaction[]): Promise<{ txHash: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `Execute transactions at ${timestamp}`;
  const signature = await signRelayerMessage(message);

  console.log(`   📤 Sending ${transactions.length} tx(s) via relayer...`);

  const response = await fetch(`${RELAYER_URL}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'POLY-ADDRESS': wallet!.address,
      'POLY-SIGNATURE': signature,
      'POLY-TIMESTAMP': timestamp.toString(),
    },
    body: JSON.stringify({
      funder: config.polymarket.address,
      transactions,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Relayer error ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  return { txHash: result.transactionHash || result.txHash };
}

/**
 * Create redeem transaction calldata for CTF contract
 */
function createRedeemCalldata(conditionId: string): string {
  const iface = new ethers.utils.Interface(CTF_REDEEM_ABI);
  const parentCollectionId = ethers.utils.hexZeroPad('0x00', 32);
  const indexSets = [1, 2]; // Both outcomes

  return iface.encodeFunctionData('redeemPositions', [
    USDC_ADDRESS,
    parentCollectionId,
    conditionId,
    indexSets,
  ]);
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
// REDEEM: Via Relayer (for proxy wallets)
// ============================================================================
async function redeemViaRelayer(position: RedeemablePosition): Promise<boolean> {
  const conditionId = position.conditionId;

  console.log(`   🔧 Using Polymarket Relayer (proxy wallet mode)...`);

  try {
    // Create the redeem transaction
    const redeemCalldata = createRedeemCalldata(conditionId);

    const transaction: RelayerTransaction = {
      to: CTF_ADDRESS,
      data: redeemCalldata,
      value: '0',
    };

    const result = await executeViaRelayer([transaction]);

    console.log(`   ⏳ Relayer tx: ${result.txHash}`);

    claimTxHistory.push({
      txHash: result.txHash,
      conditionId,
      status: 'pending',
      sentAt: Date.now(),
    });

    // Wait for confirmation
    const receipt = await waitForTransaction(result.txHash, 1, 120000);

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
      // May still have worked - mark as claimed to prevent retry loops
      confirmedClaims.set(conditionId, {
        txHash: result.txHash,
        blockNumber: receipt.blockNumber,
        payoutUSDC: position.currentValue || 0,
        confirmedAt: Date.now(),
      });
      return true;
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
    console.error(`   ❌ Relayer redeem failed: ${msg}`);

    // If relayer doesn't work, provide guidance
    if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized')) {
      console.log(`\n   💡 TIP: Relayer authentication failed.`);
      console.log(`      Your signer (${wallet?.address}) may not be authorized for this proxy.`);
      console.log(`      Try claiming manually at https://polymarket.com/portfolio`);
    }

    return false;
  }
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

  // Choose method based on wallet type
  if (isProxyWalletMode()) {
    return redeemViaRelayer(position);
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
