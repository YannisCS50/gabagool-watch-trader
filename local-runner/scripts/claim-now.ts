/**
 * Claim Now Script
 * 
 * Usage: npx tsx scripts/claim-now.ts
 * 
 * This script immediately runs the claim process to redeem all claimable positions.
 * Claims are logged to the database for tracking and auditing.
 */

import { 
  checkAndClaimWinnings, 
  getClaimableValue, 
  runReconciliation,
  getClaimStats,
  printDebugState,
} from '../src/redeemer.js';

async function main() {
  console.log('\n💰 POLYMARKET AUTO-CLAIM - MANUAL RUN');
  console.log('='.repeat(60));
  console.log(`Started at: ${new Date().toISOString()}`);

  // First show what's claimable
  console.log('\n📋 Fetching claimable positions...');
  const claimableValue = await getClaimableValue();
  console.log(`💵 Total claimable value: $${claimableValue.toFixed(2)}`);

  if (claimableValue === 0) {
    console.log('\n✅ Nothing to claim!');
    printDebugState();
    return;
  }

  // Run the claim process
  console.log('\n🚀 Running claim process...');
  const result = await checkAndClaimWinnings();

  console.log('\n' + '='.repeat(60));
  console.log(`📊 CLAIM RESULT:`);
  console.log(`   Claimed: ${result.claimed} of ${result.total} positions`);
  console.log(`   USDC received: $${result.totalUSDC.toFixed(2)}`);
  console.log('='.repeat(60));

  // Show stats
  const stats = getClaimStats();
  console.log(`\n📈 SESSION STATS:`);
  console.log(`   Total confirmed claims: ${stats.confirmed}`);
  console.log(`   Pending retries: ${stats.pending}`);
  console.log(`   Total claimed USDC: $${stats.totalClaimedUSDC.toFixed(2)}`);

  // Run reconciliation after
  console.log('\n🔄 Running post-claim reconciliation...');
  await runReconciliation();

  console.log('\n✅ Done!\n');
}

main().catch(console.error);
