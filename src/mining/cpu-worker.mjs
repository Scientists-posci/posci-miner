// Node worker_threads CPU miner. One worker = one core, hashing in a tight
// loop. Stride-based partitioning so N workers cover the nonce space without
// overlap.
//
// Started by mining/manager.mjs via:
//   new Worker(new URL('./cpu-worker.mjs', import.meta.url), { workerData: {...} })

import { parentPort, workerData } from 'node:worker_threads';
import { keccak_256 } from 'js-sha3';

const {
  challengeHex,        // 0x-prefixed 32 bytes
  minerAddrHex,        // 0x-prefixed 20 bytes (msg.sender)
  targetHex,           // 0x-prefixed uint256
  startNonceHex,       // 0x-prefixed uint256
  strideHex,           // total worker count, as bigint hex
} = workerData;

function hexToBytes(h) {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i*2, 2), 16);
  return out;
}
function bytesToHex(b) {
  let s = '0x';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
function bytesToBigIntBE(b) {
  let v = 0n;
  for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}
function nonceToBytesBE32(n) {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

const challenge = hexToBytes(challengeHex);
const miner     = hexToBytes(minerAddrHex);
const target    = BigInt(targetHex);
const stride    = BigInt(strideHex);

let nonce = BigInt(startNonceHex);
let hashes = 0;
let lastReport = Date.now();
const REPORT_MS = 750;
const BATCH = 4096;

// Reused 84-byte buffer: [challenge(32) | miner(20) | nonce(32)]
const buf = new Uint8Array(84);
buf.set(challenge, 0);
buf.set(miner, 32);

function tick() {
  for (let i = 0; i < BATCH; i++) {
    buf.set(nonceToBytesBE32(nonce), 52);
    const digestBuf = keccak_256.arrayBuffer(buf);
    const v = bytesToBigIntBE(new Uint8Array(digestBuf));
    if (v <= target) {
      parentPort.postMessage({
        type: 'hit',
        nonce: '0x' + nonce.toString(16),
        digest: bytesToHex(new Uint8Array(digestBuf)),
      });
    }
    nonce += stride;
    hashes++;
  }
  const now = Date.now();
  if (now - lastReport >= REPORT_MS) {
    parentPort.postMessage({ type: 'stats', hashes });
    hashes = 0;
    lastReport = now;
  }
  // Yield so we can receive 'stop' / 'reset' messages from the manager.
  setImmediate(tick);
}

let running = true;

parentPort.on('message', (msg) => {
  if (msg.type === 'stop') {
    running = false;
    parentPort.close();
  } else if (msg.type === 'reset') {
    // New mining job: update challenge / target / nonce
    const newChallenge = hexToBytes(msg.challengeHex);
    buf.set(newChallenge, 0);
    nonce = BigInt(msg.startNonceHex);
    if (msg.targetHex) globalThis.__target = BigInt(msg.targetHex);
  }
});

tick();
