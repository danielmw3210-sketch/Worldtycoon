// End-to-end check of the built-in Stratum pool against a mock daemon.
// Run: node server/test-stratum.mjs
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const DAEMON_PORT = 48991;
const STRATUM_PORT = 48992;
process.env.NUMISTA_DAEMON_RPC = `http://127.0.0.1:${DAEMON_PORT}`;
process.env.NUMISTA_SHARE_DIFFICULTY = '1';
process.env.NUMISTA_PAYOUT_CONFIRMATIONS = '2';
process.env.NUMISTA_PPLNS_FILE = path.join(os.tmpdir(), `pplns-test-${Date.now()}.json`);

const ADDR = 'S' + '1'.repeat(90);
const blockhashingBlob = '0a'.repeat(39) + '00000000' + 'bb'.repeat(10);
const blockTemplateBlob = '0a'.repeat(39) + '00000000' + 'cc'.repeat(80);
const seedHash = '11'.repeat(32);

let height = 100;
let difficulty = 1; // every hash is a block
const submitted = [];
const daemon = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const { method, params } = JSON.parse(body);
    let result = {};
    if (method === 'get_block_template') {
      result = { blocktemplate_blob: blockTemplateBlob, blockhashing_blob: blockhashingBlob, difficulty, height, expected_reward: 10e12, seed_hash: seedHash };
    } else if (method === 'submit_block') {
      submitted.push(params[0]);
      const nonce = Buffer.from(params[0].slice(78, 86), 'hex').readUInt32LE(0);
      daemon.nonce = nonce;
      daemon.blockHeight = height;
      result = { status: 'OK' };
    } else if (method === 'get_block_count') {
      result = { count: height + 1 };
    } else if (method === 'get_block_header_by_height') {
      result = { block_header: { nonce: daemon.nonce, orphan_status: false } };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: '0', result }));
  });
}).listen(DAEMON_PORT);

const { numistaRpc } = await import('./numista/rpc.js');
const { startBuiltInStratumServer, pplnsPool } = await import('./mining/stratumServer.js');
const { hashMeetsDifficulty } = await import('./mining/shareVerifier.js');

const payouts = [];
numistaRpc.sendTransfer = async args => { payouts.push(args); return { txHash: 'tx1' }; };

const server = startBuiltInStratumServer(STRATUM_PORT);
await new Promise(r => server.once('listening', r));

const client = net.connect(STRATUM_PORT, '127.0.0.1');
let buf = '';
const waiting = new Map();
client.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    waiting.get(msg.id)?.(msg);
  }
});
let nextId = 1;
const call = (method, params) => new Promise(resolve => {
  const id = nextId++;
  waiting.set(id, resolve);
  client.write(JSON.stringify({ id, jsonrpc: '2.0', method, params }) + '\n');
});

const login = await call('login', { login: `${ADDR}.rig1`, pass: 'x' });
assert.equal(login.result.status, 'OK');
const { job_id: jobId, target } = login.result.job;
assert.equal(target.length, 8);

const bad = await call('login', { login: 'bogus', pass: 'x' });
assert.ok(bad.error, 'invalid address rejected');

const ok = await call('submit', { id: login.result.id, job_id: jobId, nonce: '01000000' });
assert.equal(ok.result?.status, 'OK', JSON.stringify(ok));
assert.equal(submitted.length, 1, 'block candidate submitted to daemon');
assert.equal(submitted[0].slice(78, 86), '01000000');

const dup = await call('submit', { id: login.result.id, job_id: jobId, nonce: '01000000' });
assert.match(dup.error?.message || '', /Duplicate/);

const badHash = await call('submit', { id: login.result.id, job_id: jobId, nonce: '02000000', result: '00'.repeat(32) });
assert.match(badHash.error?.message || '', /Bad hash/);

const badJob = await call('submit', { id: login.result.id, job_id: 'nope', nonce: '03000000' });
assert.match(badJob.error?.message || '', /Invalid or expired/);

assert.equal(pplnsPool.pendingBlocks.length, 1);
assert.equal(pplnsPool.pending[ADDR] || 0, 0, 'no credit before confirmations');

// Chain advances past the confirmation depth: the block is credited and paid.
height += 3;
await pplnsPool.processPendingBlocks();
assert.equal(pplnsPool.blocksConfirmed, 1);
assert.equal(payouts.length, 1);
assert.equal(payouts[0].toAddress, ADDR);
assert.equal(payouts[0].amountNum, 9.8);

// Difficulty maths sanity.
assert.ok(hashMeetsDifficulty('00'.repeat(31) + '01', 1000));
assert.ok(!hashMeetsDifficulty('ff'.repeat(32), 2));

console.log('stratum pool e2e: all checks passed');
client.destroy();
server.close();
daemon.close();
process.exit(0);
