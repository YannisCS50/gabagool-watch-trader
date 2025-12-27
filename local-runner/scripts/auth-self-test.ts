import { authManager } from '../src/authManager.js';

async function main() {
  console.log('🔎 Auth self-test (dry run)');
  console.log('==========================');

  const result = await authManager.selfTest();
  for (const line of result.details) {
    console.log(`- ${line}`);
  }

  if (!result.ok) {
    console.error('\n❌ Self-test FAILED');
    process.exit(1);
  }

  console.log('\n✅ Self-test OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ Self-test crashed:', e);
  process.exit(2);
});
