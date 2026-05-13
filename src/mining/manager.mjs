// Mining manager. Spawns CPU workers (worker_threads) and/or GPU driver
// (headless Chrome with WebGPU), tracks hashrate, dedupes hits across engines,
// auto-resubmits when challenge rotates.

import { Worker } from 'node:worker_threads';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { startGpuDriver } from './gpu-driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CPU_WORKER_PATH = resolve(__dirname, 'cpu-worker.mjs');

const SMOOTH_ALPHA = 0.18;

export class MiningManager extends EventEmitter {
  constructor({
    minerAddress,
    cpuWorkers = 0,
    gpuPower   = 0,                // 1..1024 workgroups per dispatch (0 = off)
    gpuChromePath,                 // optional override
  }) {
    super();
    this.minerAddress  = minerAddress.toLowerCase();
    this.cpuCount      = cpuWorkers;
    this.gpuPower      = gpuPower;
    this.gpuChromePath = gpuChromePath;

    this.cpuStats = { hashrate: 0, totalHashes: 0n, sampledAt: Date.now(), sampledHashes: 0n };
    this.gpuStats = { hashrate: 0, totalHashes: 0n, sampledAt: Date.now(), sampledHashes: 0n };

    this.cpuWorkers = [];
    this.gpu        = null;

    this.currentJob = null;        // { challenge, target, startNonce }
    this.seenHits   = new Set();   // dedupe hits within a single challenge
    this._statTimer = null;
  }

  async start(initialJob) {
    this.currentJob = initialJob;
    if (this.cpuCount > 0) this._startCpu();
    if (this.gpuPower > 0) await this._startGpu();
    this._statTimer = setInterval(() => this._tickStats(), 500);
  }

  stop() {
    this._stopCpu();
    this._stopGpu();
    if (this._statTimer) { clearInterval(this._statTimer); this._statTimer = null; }
  }

  /** Hot-swap challenge without restarting workers. */
  setJob(job) {
    this.currentJob = job;
    this.seenHits.clear();
    for (const w of this.cpuWorkers) {
      try {
        w.postMessage({
          type: 'reset',
          challengeHex: job.challenge,
          startNonceHex: '0x' + (BigInt(job.startNonce) + BigInt(this.cpuWorkers.indexOf(w))).toString(16),
          targetHex: '0x' + job.target.toString(16),
        });
      } catch {}
    }
    if (this.gpu?.setJob) this.gpu.setJob(job);
  }

  // ---------------- CPU ----------------
  _startCpu() {
    const stride = BigInt(this.cpuCount + (this.gpuPower > 0 ? 1 : 0));
    for (let i = 0; i < this.cpuCount; i++) {
      const w = new Worker(CPU_WORKER_PATH, {
        workerData: {
          challengeHex:   this.currentJob.challenge,
          minerAddrHex:   this.minerAddress,
          targetHex:      '0x' + this.currentJob.target.toString(16),
          startNonceHex:  '0x' + (BigInt(this.currentJob.startNonce) + BigInt(i)).toString(16),
          strideHex:      '0x' + stride.toString(16),
        },
      });
      w.on('message', (msg) => this._onWorkerMsg('cpu', msg));
      w.on('error',   (e)   => this.emit('error', { source: 'cpu', error: e }));
      this.cpuWorkers.push(w);
    }
  }
  _stopCpu() {
    for (const w of this.cpuWorkers) {
      try { w.postMessage({ type: 'stop' }); } catch {}
      try { w.terminate(); } catch {}
    }
    this.cpuWorkers = [];
  }

  // ---------------- GPU ----------------
  async _startGpu() {
    try {
      const offset = BigInt(this.cpuCount);
      this.gpu = await startGpuDriver({
        challengeHex: this.currentJob.challenge,
        minerAddrHex: this.minerAddress,
        targetHex:    '0x' + this.currentJob.target.toString(16),
        startNonceHex:'0x' + (BigInt(this.currentJob.startNonce) + offset).toString(16),
        powerWorkgroups: this.gpuPower,
        chromePath:   this.gpuChromePath,
        onHit:    (h) => this._onWorkerMsg('gpu', { type: 'hit',   ...h }),
        onStats:  (s) => this._onWorkerMsg('gpu', { type: 'stats', hashes: s.delta }),
        onError:  (e) => this.emit('error', { source: 'gpu', error: e }),
      });
    } catch (e) {
      this.emit('error', { source: 'gpu-init', error: e });
      this.gpu = null;
    }
  }
  _stopGpu() {
    if (this.gpu?.stop) this.gpu.stop();
    this.gpu = null;
  }

  // ---------------- shared ----------------
  _onWorkerMsg(source, msg) {
    if (msg.type === 'stats') {
      const s = source === 'cpu' ? this.cpuStats : this.gpuStats;
      s.totalHashes += BigInt(msg.hashes);
    } else if (msg.type === 'hit') {
      const k = msg.digest;
      if (this.seenHits.has(k)) return;
      this.seenHits.add(k);
      this.emit('hit', { source, nonce: BigInt(msg.nonce), digest: msg.digest });
    }
  }

  _tickStats() {
    const now = Date.now();
    for (const s of [this.cpuStats, this.gpuStats]) {
      const dt = (now - s.sampledAt) / 1000;
      const dh = Number(s.totalHashes - s.sampledHashes);
      const inst = dt > 0 ? dh / dt : 0;
      s.hashrate = s.hashrate * (1 - SMOOTH_ALPHA) + inst * SMOOTH_ALPHA;
      s.sampledAt = now;
      s.sampledHashes = s.totalHashes;
    }
    this.emit('stats', {
      cpu: { ...this.cpuStats }, gpu: { ...this.gpuStats },
      total: this.cpuStats.hashrate + this.gpuStats.hashrate,
    });
  }
}
