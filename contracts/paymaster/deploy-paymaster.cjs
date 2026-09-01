// Zor Paymaster Deployment Script
// Deploys the ZorPaymaster contract to Starknet Sepolia
//
// Usage: node deploy-paymaster.js
//
// Prerequisites:
// 1. Compile the contract: scarb build
// 2. The deployer account must have STRK for gas

const { RpcProvider, Account, Contract, json } = require('starknet');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────

const RPC_URL = 'https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_10/alch_-87xFRsdib2F_f-o2GBMV';
const DEPLOYER_PRIVATE_KEY = '0x05e7980aefdb896dc3456cd5fcbf53384136b0fe2e6185787ddcb972e9e85925';
const DEPLOYER_ADDRESS = '0x12f8b399a2eff402e22ea47be559d7e369cb5a18bcb426834a079947018a2d';
const POOL_ADDRESS = '0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log('🔧 Deploying Zor Paymaster to Sepolia...\n');

  // 1. Setup provider and account
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const deployer = new Account({ provider, address: DEPLOYER_ADDRESS, signer: DEPLOYER_PRIVATE_KEY, cairoVersion: '1' });

  console.log(`Deployer: ${DEPLOYER_ADDRESS}`);
  console.log(`Pool: ${POOL_ADDRESS}\n`);

  // 2. Load compiled contract
  const sierraPath = path.join(__dirname, 'target/dev/zor_paymaster_ZorPaymaster.contract_class.json');
  const casmPath = path.join(__dirname, 'target/dev/zor_paymaster_ZorPaymaster.compiled_contract_class.json');

  if (!fs.existsSync(sierraPath)) {
    console.error('❌ Sierra class not found. Run: scarb build');
    process.exit(1);
  }

  const sierraClass = json.parse(fs.readFileSync(sierraPath, 'utf8'));
  const casmClass = json.parse(fs.readFileSync(casmPath, 'utf8'));

  console.log('✅ Compiled contract loaded\n');

  // 3. Declare the contract class (skip if already declared)
  console.log('📝 Declaring contract class...');
  let classHash;
  try {
    const declareTx = await deployer.declare({
      contract: sierraClass,
      casm: casmClass,
    });
    classHash = declareTx.class_hash;
    console.log(`   Class hash: ${classHash}`);
    console.log(`   Declare tx: ${declareTx.transaction_hash}`);
    console.log('   Waiting for declare confirmation...');
    await provider.waitForTransaction(declareTx.transaction_hash);
    console.log('   ✅ Declared\n');
  } catch (e) {
    if (e.message && e.message.includes('already declared')) {
      classHash = '0x70c0cf542504f5c83ab8308cd8887e2e2f6ed48268f94b6115bb3ec40e96ba2';
      console.log(`   ✅ Already declared (class hash: ${classHash})\n`);
    } else {
      throw e;
    }
  }

  // 4. Deploy the contract
  // Constructor args: owner (address)
  console.log('🚀 Deploying paymaster...');
  const deployResult = await deployer.deployContract({
    classHash: classHash,
    constructorCalldata: [DEPLOYER_ADDRESS], // owner = deployer
  });
  const paymasterAddress = deployResult.contract_address;
  console.log(`   Paymaster address: ${paymasterAddress}\n`);

  // 5. Add pool to allowed list
  console.log('🔗 Adding pool to allowed list...');
  
  // Build the call directly
  const addPoolResult = await deployer.execute(
    [{
      contractAddress: paymasterAddress,
      entrypoint: 'add_allowed_pool',
      calldata: [POOL_ADDRESS],
    }],
    undefined, // details (auto)
    undefined, // abis
  );
  await provider.waitForTransaction(addPoolResult.transaction_hash);
  console.log(`   Pool ${POOL_ADDRESS} added (tx: ${addPoolResult.transaction_hash})\n`);

  // 6. Verify
  const verifyResult = await provider.callContract({
    contractAddress: paymasterAddress,
    entrypoint: 'is_pool_allowed',
    calldata: [POOL_ADDRESS],
  });
  const isAllowed = verifyResult[0] !== '0x0';
  console.log(`✅ Pool allowed: ${isAllowed}`);

  // 7. Summary
  console.log('\n' + '═'.repeat(60));
  console.log('📋 DEPLOYMENT SUMMARY');
  console.log('═'.repeat(60));
  console.log(`Paymaster Address: ${paymasterAddress}`);
  console.log(`Owner:             ${DEPLOYER_ADDRESS}`);
  console.log(`Allowed Pool:      ${POOL_ADDRESS}`);
  console.log(`Class Hash:        ${classHash}`);
  console.log('═'.repeat(60));
  console.log('\nTo fund the paymaster, transfer STRK to:');
  console.log(`  ${paymasterAddress}`);
  console.log('\nFrontend config:');
  console.log(`  paymasterAddress: "${paymasterAddress}"`);
}

main().catch(e => {
  console.error('❌ Deployment failed:', e.message);
  process.exit(1);
});
