/**
 * Claim Debug Script
 * 
 * Usage: npx tsx scripts/claim-debug.ts
 * 
 * This script:
 * 1. Lists all claimable positions per wallet
 * 2. Inspects recent claim transactions
 * 3. Identifies why positions might still show as claimable in UI
 */

import { config } from '../src/config.js';
import { ethers, Wallet } from 'ethers';
import {
  getProvider,
  getBlockNumber,
  getRecentPayoutRedemptions,
  getCurrentNonce,
  CTF_ADDRESS,
} from '../src/chain.js';
import { reconcile, printReconciliationReport } from '../src/reconcile.js';

const DATA_API_URL = 'https://data-api.polymarket.com';

interface Position {
  conditionId: string;
  size: number;
  currentValue: number;
  redeemable: boolean;
  title: string;
  outcome: string;
  proxyWallet: string;
}

async function fetchAllPositions(wallet: string): Promise<Position[]> {
  const positions: Position[] = [];
  let cursor: string | null = null;
  let page = 0;

  while (page < 10) {
    page++;
    let url = `${DATA_API_URL}/positions?user=${wallet}&sizeThreshold=0&limit=500`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    const response = await fetch(url);
    if (!response.ok) break;

    const data = await response.json();
    const items = Array.isArray(data) ? data : data.positions || [];
    const nextCursor = data.next_cursor || data.nextCursor;

    positions.push(...items.map((p: any) => ({
      conditionId: p.conditionId,
      size: p.size || 0,
      currentValue: p.currentValue || 0,
      redeemable: p.redeemable || false,
      title: p.title || p.slug || '',
      outcome: p.outcome || '',
      proxyWallet: p.proxyWallet || wallet,
    })));

    if (!nextCursor || nextCursor === cursor || items.length === 0) break;
    cursor = nextCursor;
  }

  return positions;
}

async function main() {
  console.log('\n🔍 POLYMARKET CLAIM DEBUG');
  console.log('='.repeat(60));

  // Initialize
  const provider = getProvider();
  const signer = new Wallet(config.polymarket.privateKey, provider);
  const proxyWallet = config.polymarket.address;

  console.log('\n📍 WALLET ADDRESSES:');
  console.log(`   Signer (EOA): ${signer.address}`);
  console.log(`   Proxy (config): ${proxyWallet || 'not set'}`);

  // Check balances
  const signerBalance = await provider.getBalance(signer.address);
  console.log(`   Signer MATIC balance: ${ethers.utils.formatEther(signerBalance)} MATIC`);

  // Get current nonce
  const nonce = await getCurrentNonce(signer.address);
  console.log(`   Current nonce: ${nonce}`);

  // Wallets to check
  const wallets = new Set<string>();
  wallets.add(signer.address.toLowerCase());
  if (proxyWallet) wallets.add(proxyWallet.toLowerCase());

  console.log('\n📋 POSITIONS BY WALLET:');
  console.log('-'.repeat(60));

  let totalClaimable = 0;
  const allClaimableConditions: string[] = [];

  for (const wallet of wallets) {
    const positions = await fetchAllPositions(wallet);
    const redeemable = positions.filter(p => p.redeemable);

    console.log(`\n📍 ${wallet}:`);
    console.log(`   Total positions: ${positions.length}`);
    console.log(`   Redeemable: ${redeemable.length}`);

    if (redeemable.length > 0) {
      console.log('\n   💰 CLAIMABLE POSITIONS:');
      for (const p of redeemable) {
        console.log(`   • ${p.outcome} ${p.size.toFixed(0)} shares | $${p.currentValue.toFixed(2)}`);
        console.log(`     ${p.title.slice(0, 50)}`);
        console.log(`     ConditionId: ${p.conditionId}`);
        totalClaimable += p.currentValue;
        allClaimableConditions.push(p.conditionId);
      }
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`💰 TOTAL CLAIMABLE: $${totalClaimable.toFixed(2)}`);
  console.log('-'.repeat(60));

  // Check recent claims on-chain
  console.log('\n📤 RECENT ON-CHAIN CLAIMS (last ~1 hour):');
  console.log('-'.repeat(60));

  const currentBlock = await getBlockNumber();
  const fromBlock = currentBlock - 1800; // ~1 hour

  for (const wallet of wallets) {
    const claims = await getRecentPayoutRedemptions(wallet, fromBlock);
    console.log(`\n📍 ${wallet.slice(0, 10)}...: ${claims.length} claims`);

    for (const claim of claims) {
      const isStillClaimable = allClaimableConditions.includes(claim.conditionId);
      const status = isStillClaimable ? '⚠️ STILL IN API' : '✅ cleared';

      console.log(`   • $${claim.payoutUSDC.toFixed(2)} | block ${claim.blockNumber} | ${status}`);
      console.log(`     ConditionId: ${claim.conditionId}`);
      console.log(`     Tx: ${claim.transactionHash}`);
    }
  }

  // Run full reconciliation
  console.log('\n🔄 RUNNING FULL RECONCILIATION...');
  const result = await reconcile(signer.address);
  printReconciliationReport(result);

  // Diagnosis for the 2 open claims
  if (allClaimableConditions.length > 0) {
    console.log('\n⚠️ DIAGNOSIS FOR OPEN CLAIMS:');
    console.log('-'.repeat(60));

    for (const conditionId of allClaimableConditions) {
      const matchingDisc = result.discrepancies.find(d => d.conditionId === conditionId);
      
      if (matchingDisc) {
        console.log(`\n📋 ConditionId: ${conditionId}`);
        console.log(`   Issue: ${matchingDisc.issue}`);
        console.log(`   Details: ${matchingDisc.details}`);

        if (matchingDisc.issue === 'wrong_wallet') {
          console.log(`   💡 FIX: This position belongs to a different wallet than your signer.`);
          console.log(`          You need to claim from the wallet that holds this position.`);
        } else if (matchingDisc.issue === 'not_claimed') {
          console.log(`   💡 FIX: Run the claim bot to claim this position.`);
        } else if (matchingDisc.issue === 'indexer_delay') {
          console.log(`   💡 FIX: Already claimed! Wait a few minutes for the API to update.`);
        }
      }
    }
  }

  console.log('\n✅ Debug complete\n');
}

main().catch(console.error);
