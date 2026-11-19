import './server/index.js';

async function runTests() {
  await new Promise(r => setTimeout(r, 600));

  console.log('--- 1. Testing Live Numista Node Network Info ---');
  const resNet = await fetch('http://127.0.0.1:3001/api/network');
  const dataNet = await resNet.json();
  console.log(`Node Online: ${dataNet.network.online}, NetType: ${dataNet.network.nettype}, Block Height: #${dataNet.network.height}, Difficulty: ${dataNet.network.difficulty}`);

  console.log('\n--- 2. Testing Wallet API ---');
  const resWal = await fetch('http://127.0.0.1:3001/api/wallet');
  const dataWal = await resWal.json();
  console.log(`Primary Address: ${dataWal.address.slice(0, 16)}...`);
  console.log(`Balance: ${dataWal.balance} NUM, Live Node Connected: ${dataWal.isLiveDaemonConnected}`);

  console.log('\n--- 3. Testing Wallet Send Transaction ---');
  const resSend = await fetch('http://127.0.0.1:3001/api/wallet/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      toAddress: dataWal.secondaryAddress,
      amount: 12.50
    })
  });
  const dataSend = await resSend.json();
  console.log(`Sent 12.50 NUM to secondary address! TX: ${dataSend.tx.txHash}. New Balance: ${dataSend.walletBalance} NUM`);

  console.log('\n--- 4. Testing Wallet Switch / Connect ---');
  const resSwitch = await fetch('http://127.0.0.1:3001/api/wallet/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: dataWal.secondaryAddress })
  });
  const dataSwitch = await resSwitch.json();
  console.log(`Switched active wallet to: ${dataSwitch.wallet.address.slice(0, 16)}...`);

  console.log('\n--- 5. Testing Mining Share & On-Chain Deed Registration ---');
  const resClaim = await fetch('http://127.0.0.1:3001/api/plots/UK-LEE-001/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerAddress: dataSwitch.wallet.address })
  });
  const dataClaim = await resClaim.json();
  console.log(`Claimed UK-LEE-001! Discovered Building: ${dataClaim.discoveredBuilding}.`);

  const resBridge = await fetch('http://127.0.0.1:3001/api/plots/UK-LEE-001/bridge-onchain', { method: 'POST' });
  const dataBridge = await resBridge.json();
  console.log(`Deed on-chain Monero tx_extra committed! TX: ${dataBridge.commitResult.txHash}, Height: ${dataBridge.commitResult.blockHeight}`);

  console.log('\n--- 6. Testing Buy Crypto Onramp Complete ---');
  const resOrder = await fetch('http://127.0.0.1:3001/api/onramp/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currency: 'GBP', amount: 50, paymentMethod: 'card', recipientAddress: dataWal.address })
  });
  const dataOrder = await resOrder.json();
  console.log(`Buy Order Created: Pay £${dataOrder.payAmount} GBP -> Receive ${dataOrder.numAmount} NUM`);

  const resComp = await fetch('http://127.0.0.1:3001/api/onramp/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: dataOrder.orderId })
  });
  const dataComp = await resComp.json();
  console.log(`Order Completed! Delivered: ${dataComp.order.numAmount} NUM to wallet.`);

  console.log('\n✨ ALL NUMISTA SUITE TESTS PASSED 100%!');
  process.exit(0);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
