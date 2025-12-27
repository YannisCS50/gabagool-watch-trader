import { config } from './config.js';
import { 
  getProvider, 
  getBlockNumber, 
  getRecentPayoutRedemptions,
  PayoutRedemptionEvent 
} from './chain.js';

// Polymarket Data API
const DATA_API_URL = 'https://data-api.polymarket.com';

export interface ClaimablePosition {
  proxyWallet: string;
  conditionId: string;
  size: number;
  currentValue: number;
  title: string;
  slug: string;
  outcome: string;
}

export interface ReconciliationResult {
  claimables: ClaimablePosition[];
  recentClaims: PayoutRedemptionEvent[];
  discrepancies: {
    conditionId: string;
    issue: 'indexer_delay' | 'wrong_wallet' | 'not_claimed' | 'unknown';
    details: string;
  }[];
  summary: string;
}

/**
 * Fetch claimable positions from Polymarket API for a wallet
 */
async function fetchClaimablesForWallet(wallet: string): Promise<ClaimablePosition[]> {
  const positions: ClaimablePosition[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  const maxPages = 10;

  while (pageCount < maxPages) {
    pageCount++;
    let url = `${DATA_API_URL}/positions?user=${wallet}&sizeThreshold=0&limit=500`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        console.error(`❌ API error for ${wallet}: HTTP ${response.status}`);
        break;
      }

      const data = await response.json();
      
      let items: any[];
      let nextCursor: string | null = null;

      if (Array.isArray(data)) {
        items = data;
      } else if (data.positions && Array.isArray(data.positions)) {
        items = data.positions;
        nextCursor = data.next_cursor || data.nextCursor || null;
      } else {
        break;
      }

      for (const p of items) {
        if (p.redeemable) {
          positions.push({
            proxyWallet: p.proxyWallet || wallet,
            conditionId: p.conditionId,
            size: p.size || 0,
            currentValue: p.currentValue || 0,
            title: p.title || '',
            slug: p.slug || '',
            outcome: p.outcome || '',
          });
        }
      }

      if (!nextCursor || nextCursor === cursor || items.length === 0) break;
      cursor = nextCursor;
    } catch (e) {
      console.error(`❌ Error fetching positions for ${wallet}:`, e);
      break;
    }
  }

  return positions;
}

/**
 * Reconcile claimable positions vs on-chain claims
 */
export async function reconcile(signerAddress: string): Promise<ReconciliationResult> {
  console.log('\n🔍 Starting reconciliation...');
  
  // 1. Get all relevant wallet addresses
  const proxyWallet = config.polymarket.address;
  const wallets = new Set<string>();
  if (proxyWallet) wallets.add(proxyWallet.toLowerCase());
  wallets.add(signerAddress.toLowerCase());

  console.log(`   📍 Wallets to check: ${[...wallets].join(', ')}`);

  // 2. Fetch claimables from API
  const allClaimables: ClaimablePosition[] = [];
  for (const wallet of wallets) {
    const claimables = await fetchClaimablesForWallet(wallet);
    allClaimables.push(...claimables);
    console.log(`   📊 ${wallet.slice(0, 10)}...: ${claimables.length} claimables`);
  }

  // Dedupe by conditionId
  const claimableByCondition = new Map<string, ClaimablePosition>();
  for (const c of allClaimables) {
    if (!claimableByCondition.has(c.conditionId) || c.currentValue > (claimableByCondition.get(c.conditionId)?.currentValue || 0)) {
      claimableByCondition.set(c.conditionId, c);
    }
  }
  const claimables = [...claimableByCondition.values()];

  console.log(`   💰 Total unique claimables: ${claimables.length}`);

  // 3. Get recent on-chain claims (last ~10 minutes = ~300 blocks on Polygon)
  // Note: Polygon RPC limits block range queries, so we use a smaller range
  const currentBlock = await getBlockNumber();
  const fromBlock = currentBlock - 300; // Reduced from 1800 to avoid "Block range too large"

  const allClaims: PayoutRedemptionEvent[] = [];
  for (const wallet of wallets) {
    try {
      const claims = await getRecentPayoutRedemptions(wallet, fromBlock);
      allClaims.push(...claims);
      console.log(`   📤 ${wallet.slice(0, 10)}...: ${claims.length} recent claims`);
    } catch (e: any) {
      console.log(`   ⚠️ ${wallet.slice(0, 10)}...: Could not fetch claims (RPC limit)`);
    }
  }

  // 4. Identify discrepancies
  const claimedConditions = new Set(allClaims.map(c => c.conditionId.toLowerCase()));
  const discrepancies: ReconciliationResult['discrepancies'] = [];

  for (const claimable of claimables) {
    const conditionId = claimable.conditionId.toLowerCase();
    
    if (claimedConditions.has(conditionId)) {
      // Claimed on-chain but still showing in API - likely indexer delay
      discrepancies.push({
        conditionId: claimable.conditionId,
        issue: 'indexer_delay',
        details: `Claimed on-chain but API still shows redeemable. Will resolve in a few blocks.`,
      });
    } else {
      // Not claimed on-chain - check if it belongs to a different wallet
      const belongsToWallet = [...wallets].some(
        w => claimable.proxyWallet.toLowerCase() === w
      );
      
      if (!belongsToWallet) {
        discrepancies.push({
          conditionId: claimable.conditionId,
          issue: 'wrong_wallet',
          details: `Position belongs to ${claimable.proxyWallet}, not in our wallet set.`,
        });
      } else {
        discrepancies.push({
          conditionId: claimable.conditionId,
          issue: 'not_claimed',
          details: `Position at ${claimable.proxyWallet.slice(0, 10)}... ($${claimable.currentValue.toFixed(2)}) needs to be claimed.`,
        });
      }
    }
  }

  // 5. Generate summary
  const indexerDelays = discrepancies.filter(d => d.issue === 'indexer_delay').length;
  const wrongWallets = discrepancies.filter(d => d.issue === 'wrong_wallet').length;
  const notClaimed = discrepancies.filter(d => d.issue === 'not_claimed').length;

  let summary = `Reconciliation complete: ${claimables.length} claimables, ${allClaims.length} recent claims.`;
  
  if (indexerDelays > 0) {
    summary += ` ${indexerDelays} pending indexer updates.`;
  }
  if (wrongWallets > 0) {
    summary += ` ${wrongWallets} positions belong to other wallets.`;
  }
  if (notClaimed > 0) {
    summary += ` ${notClaimed} positions need claiming.`;
  }
  if (discrepancies.length === 0) {
    summary += ` All positions reconciled!`;
  }

  console.log(`\n📋 ${summary}`);

  return {
    claimables,
    recentClaims: allClaims,
    discrepancies,
    summary,
  };
}

/**
 * Print detailed reconciliation report
 */
export function printReconciliationReport(result: ReconciliationResult): void {
  console.log('\n' + '='.repeat(60));
  console.log('RECONCILIATION REPORT');
  console.log('='.repeat(60));

  if (result.claimables.length > 0) {
    console.log('\n📋 CLAIMABLE POSITIONS:');
    for (const c of result.claimables) {
      console.log(`   • ${c.outcome} ${c.size.toFixed(0)} shares @ ${c.title.slice(0, 50)}`);
      console.log(`     Value: $${c.currentValue.toFixed(2)} | Wallet: ${c.proxyWallet.slice(0, 10)}...`);
      console.log(`     ConditionId: ${c.conditionId}`);
    }
  }

  if (result.recentClaims.length > 0) {
    console.log('\n📤 RECENT CLAIMS (last ~1 hour):');
    for (const c of result.recentClaims) {
      console.log(`   • Claimed $${c.payoutUSDC.toFixed(2)} in block ${c.blockNumber}`);
      console.log(`     ConditionId: ${c.conditionId}`);
      console.log(`     Tx: ${c.transactionHash}`);
    }
  }

  if (result.discrepancies.length > 0) {
    console.log('\n⚠️ DISCREPANCIES:');
    for (const d of result.discrepancies) {
      const icon = d.issue === 'indexer_delay' ? '⏳' : d.issue === 'wrong_wallet' ? '👤' : '❌';
      console.log(`   ${icon} [${d.issue}] ${d.details}`);
      console.log(`      ConditionId: ${d.conditionId}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`SUMMARY: ${result.summary}`);
  console.log('='.repeat(60) + '\n');
}
