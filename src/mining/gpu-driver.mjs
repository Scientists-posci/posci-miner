// GPU mining driver: spawns a headless Chrome with WebGPU enabled, loads a
// local mining page (gpu-page.html with our WGSL shader), and tunnels
// hits + hashrate back over a localhost WebSocket.
//
// Why a Chrome subprocess instead of a native binding?
//   - Reuses the same shader the web frontend already uses (battle-tested)
//   - Works on Mac/Win/Linux as long as Chrome+GPU drivers are present
//   - Zero native build step for users
//
// Tradeoffs:
//   - Chrome adds ~200-400 MB RSS
//   - Headless WebGPU on some Linux distros has no real driver, so the
//     opt-in env var POSCI_GPU_SWIFTSHADER=1 enables the CPU SwiftShader
//     fallback. NEVER enable that on Mac/Windows — it would override the
//     real Metal/D3D12 backend with CPU software rendering.

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { KECCAK256_WGSL } from './keccak256.wgsl.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  process.env.POSCI_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome(override) {
  if (override && existsSync(override)) return override;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    'No Chrome/Edge/Chromium binary found. Install Chrome OR set POSCI_CHROME_PATH.\n' +
    '  Win:   https://www.google.com/chrome/\n' +
    '  Mac:   brew install --cask google-chrome\n' +
    '  Linux: apt install chromium-browser   (or your distro equivalent)'
  );
}

const PAGE_HTML = (wsPort) => `<!doctype html>
<html><head><meta charset="utf-8"><title>POSCI GPU miner</title>
<style>body{font:14px monospace;background:#000;color:#0f0;padding:16px}</style></head>
<body>
<div id="status">connecting…</div>
<script type="module">
const WORKGROUP_SIZE = 64;
const PER_THREAD     = 32;

const status = document.getElementById('status');
function log(s) { status.textContent = s; }

const ws = new WebSocket('ws://localhost:${wsPort}');
let job = null, runId = 0, device = null, pipeline = null, paramsBuf = null, hitsBuf = null, readBuf = null, bindGroup = null;

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'job') { job = m.job; runId++; mineLoop(runId); }
};

const KECCAK256_WGSL = ${JSON.stringify(KECCAK256_WGSL)};

function hexToU8(h) {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i*2, 2), 16);
  return out;
}
function u8ToHex(b) {
  let s = '0x'; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2,'0');
  return s;
}
function bigIntTo32BE(v) {
  const out = new Uint8Array(32); let n = BigInt(v);
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; } return out;
}
function packLE(bytes, limbs) {
  const out = new Uint32Array(limbs);
  for (let i = 0; i < limbs; i++) {
    const o = i*4;
    out[i] = (bytes[o]??0) | ((bytes[o+1]??0)<<8) | ((bytes[o+2]??0)<<16) | ((bytes[o+3]??0)<<24);
  } return out;
}
function packBE(bytes) {
  const out = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    const o = i*4;
    out[i] = ((bytes[o]??0)<<24) | ((bytes[o+1]??0)<<16) | ((bytes[o+2]??0)<<8) | (bytes[o+3]??0);
  } return out;
}

async function init() {
  if (!('gpu' in navigator)) { log('WebGPU NOT available in this Chrome'); ws.send(JSON.stringify({type:'error',msg:'webgpu unavailable'})); return false; }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) { log('No WebGPU adapter'); ws.send(JSON.stringify({type:'error',msg:'no adapter'})); return false; }
  const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
  const blob = ((info.vendor||'') + ' ' + (info.architecture||'') + ' ' + (info.device||'') + ' ' + (info.description||'')).toLowerCase();
  const software = /swiftshader|llvmpipe|software|microsoft basic|warp/.test(blob);
  ws.send(JSON.stringify({type:'adapter', vendor:info.vendor||'', device:info.device||'', architecture:info.architecture||'', description:info.description||'', software}));
  device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: KECCAK256_WGSL });
  pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

  const PARAMS_BYTES = 32+32+32+16;
  const HIT_SIZE = 64;
  const HITS_BYTES = 16 + 16 * HIT_SIZE;
  paramsBuf = device.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  hitsBuf   = device.createBuffer({ size: HITS_BYTES,   usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  readBuf   = device.createBuffer({ size: HITS_BYTES,   usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: hitsBuf } },
    ],
  });
  log('GPU ready');
  return true;
}

function writeParams(challenge, miner, target, baseNonce, perThread) {
  const data = new ArrayBuffer(112);
  const u32 = new Uint32Array(data);
  const c = packLE(challenge, 8); for (let i = 0; i < 8; i++) u32[i] = c[i];
  const m = packLE(miner, 8);     for (let i = 0; i < 8; i++) u32[8+i] = m[i];
  const t = packBE(bigIntTo32BE(target)); for (let i = 0; i < 8; i++) u32[16+i] = t[i];
  const nLo = Number(baseNonce & 0xffffffffn);
  const nHi = Number((baseNonce >> 32n) & 0xffffffffn);
  u32[24] = nLo; u32[25] = nHi; u32[26] = perThread; u32[27] = 0;
  device.queue.writeBuffer(paramsBuf, 0, data);
}

async function mineLoop(myRunId) {
  if (!device && !(await init())) return;
  const challenge = hexToU8(job.challenge);
  const miner     = hexToU8(job.miner);
  const target    = BigInt(job.target);
  let nonce       = BigInt(job.startNonce);

  while (myRunId === runId && job) {
    writeParams(challenge, miner, target, nonce, PER_THREAD);
    device.queue.writeBuffer(hitsBuf, 0, new Uint32Array([0,0,0,0]));
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(${'job.power'} || 64);
    pass.end();
    enc.copyBufferToBuffer(hitsBuf, 0, readBuf, 0, 16 + 16*64);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const arr = new Uint32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();

    const count = Math.min(arr[0], 16);
    for (let i = 0; i < count; i++) {
      const off = 4 + i * 16;
      const lo = arr[off], hi = arr[off+1];
      const n = (BigInt(hi) << 32n) | BigInt(lo);
      const dBytes = new Uint8Array(32);
      for (let k = 0; k < 8; k++) {
        const w = arr[off+4+k];
        dBytes[k*4]   = (w>>>24)&0xff; dBytes[k*4+1] = (w>>>16)&0xff;
        dBytes[k*4+2] = (w>>>8)&0xff;  dBytes[k*4+3] =  w        &0xff;
      }
      ws.send(JSON.stringify({type:'hit', nonce:'0x'+n.toString(16), digest: u8ToHex(dBytes)}));
    }

    const power = job.power || 64;
    const tried = BigInt(power) * BigInt(WORKGROUP_SIZE) * BigInt(PER_THREAD);
    nonce += tried;
    ws.send(JSON.stringify({type:'stats', delta: Number(tried)}));
    log('GPU mining · nonce ' + nonce.toString(16).slice(0, 16) + '…');
  }
}
</script></body></html>`;

/**
 * Start the GPU driver. Returns { stop, setJob }.
 */
export async function startGpuDriver({
  challengeHex, minerAddrHex, targetHex, startNonceHex,
  powerWorkgroups = 64,
  chromePath, onHit, onStats, onError, onAdapter,
}) {
  const chrome = findChrome(chromePath);

  // 1. Local WebSocket bridge for IPC with the headless Chrome page
  const httpServer = createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PAGE_HTML(wsPort));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const httpPort = httpServer.address().port;

  const wsServer = new WebSocketServer({ server: httpServer });
  let wsClient = null;
  const wsPort = httpPort;        // sharing same port (HTTP+WS upgrade)

  let currentJob = {
    challenge: challengeHex, miner: minerAddrHex,
    target: targetHex, startNonce: startNonceHex,
    power: powerWorkgroups,
  };

  wsServer.on('connection', (ws) => {
    wsClient = ws;
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'hit')     onHit?.({ nonce: m.nonce, digest: m.digest });
        else if (m.type === 'stats') onStats?.({ delta: m.delta });
        else if (m.type === 'error') onError?.(new Error(m.msg));
        else if (m.type === 'adapter') onAdapter?.(m);
      } catch (e) { onError?.(e); }
    });
    // Push the initial job
    ws.send(JSON.stringify({ type: 'job', job: currentJob }));
  });

  // 2. Spawn Chrome pointed at the local page.
  // Chrome's WebGPU backend is platform-specific: Metal on macOS, D3D12 on
  // Windows, Vulkan on Linux. The old flag set forced SwiftShader (CPU)
  // everywhere, which silently killed GPU acceleration on Mac/Windows.
  // Now: only enable WebGPU explicitly; opt-in CPU fallback for Linux servers
  // without a real GPU driver via POSCI_GPU_SWIFTSHADER=1.
  const userDataDir = join(tmpdir(), `posci-miner-${process.pid}-${Date.now()}`);
  const isLinux = process.platform === 'linux';
  const useSwiftShader = isLinux && process.env.POSCI_GPU_SWIFTSHADER === '1';
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-webgpu',
    ...(useSwiftShader
      ? ['--enable-features=Vulkan', '--use-vulkan=swiftshader']
      : []),
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=0`,
    '--no-first-run',
    '--disable-translate',
    '--disable-extensions',
    `http://127.0.0.1:${httpPort}/page`,
  ];
  const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', (e) => onError?.(e));

  return {
    setJob(job) {
      currentJob = {
        challenge: job.challenge, miner: job.miner ?? minerAddrHex,
        target: '0x' + (job.target?.toString(16) ?? job.targetHex?.replace('0x', '')),
        startNonce: '0x' + (job.startNonce?.toString(16) ?? job.startNonceHex?.replace('0x', '')),
        power: powerWorkgroups,
      };
      wsClient?.send(JSON.stringify({ type: 'job', job: currentJob }));
    },
    stop() {
      try { child.kill(); } catch {}
      try { httpServer.close(); } catch {}
      try { wsServer.close(); } catch {}
    },
  };
}
