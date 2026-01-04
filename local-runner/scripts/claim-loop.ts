/**
 * Claim Loop Script
 * 
 * Usage: npx tsx scripts/claim-loop.ts [interval_minutes]
 * 
 * This script starts the auto-claim loop that periodically checks for
 * and claims resolved positions. Default interval is 5 minutes.
 * 
 * Examples:
 *   npx tsx scripts/claim-loop.ts        # Default 5 minute interval
 *   npx tsx scripts/claim-loop.ts 10     # 10 minute interval
 *   npx tsx scripts/claim-loop.ts 1      # 1 minute interval (aggressive)
 */

import { 
  startAutoClaimLoop, 
  stopAutoClaimLoop,
  getClaimStats,
  printDebugState,
} from '../src/redeemer.js';

const DEFAULT_INTERVAL_MINUTES = 5;

async function main() {
  // Parse interval from command line
  const intervalArg = process.argv[2];
  const intervalMinutes = intervalArg ? parseInt(intervalArg, 10) : DEFAULT_INTERVAL_MINUTES;
  
  if (isNaN(intervalMinutes) || intervalMinutes < 1) {
    console.error('❌ Invalid interval. Must be a positive number of minutes.');
    process.exit(1);
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  console.log('\n💰 POLYMARKET AUTO-CLAIM LOOP');
  console.log('='.repeat(60));
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Interval: ${intervalMinutes} minute(s)`);
  console.log('='.repeat(60));
  console.log('\nPress Ctrl+C to stop\n');

  // Start the auto-claim loop
  startAutoClaimLoop(intervalMs);

  // Handle graceful shutdown
  const shutdown = () => {
    console.log('\n\n⏹️ Shutting down auto-claim loop...');
    stopAutoClaimLoop();
    
    const stats = getClaimStats();
    console.log('\n📊 SESSION SUMMARY:');
    console.log(`   Total confirmed claims: ${stats.confirmed}`);
    console.log(`   Pending retries: ${stats.pending}`);
    console.log(`   Total claimed USDC: $${stats.totalClaimedUSDC.toFixed(2)}`);
    
    console.log('\n✅ Goodbye!\n');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Print stats every hour
  setInterval(() => {
    console.log('\n📈 HOURLY STATS:');
    printDebugState();
  }, 60 * 60 * 1000);

  // Keep the process running
  await new Promise(() => {});
}

main().catch(console.error);
