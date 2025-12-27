/**
 * Claim Now Script
 * 
 * Usage: npx tsx scripts/claim-now.ts
 * 
 * This script immediately runs the claim process to redeem all claimable positions.
 */

import { checkAndClaimWinnings, getClaimableValue, runReconciliation } from '../src/redeemer.js';

async function main() {
  console.log('\n💰 POLYMARKET CLAIM - MANUAL RUN');
  console.log('='.repeat(60));

  // First show what's claimable
  console.log('\n📋 Fetching claimable positions...');
  const claimableValue = await getClaimableValue();
  console.log(`💵 Total claimable value: $${claimableValue.toFixed(2)}`);

  if (claimableValue === 0) {
    console.log('\n✅ Nothing to claim!');
    return;
  }

  // Run the claim process
  console.log('\n🚀 Running claim process...');
  const result = await checkAndClaimWinnings();

  console.log('\n' + '='.repeat(60));
  console.log(`📊 RESULT: Claimed ${result.claimed} of ${result.total} positions`);
  console.log('='.repeat(60));

  // Run reconciliation after
  console.log('\n🔄 Running post-claim reconciliation...');
  await runReconciliation();

  console.log('\n✅ Done!\n');
}

main().catch(console.error);
