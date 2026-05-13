// In-place TUI dashboard: redraws once per second using ANSI cursor moves.
// Renders to stdout if it's a TTY; otherwise falls back to one-line stats.

import { c } from '../lib/log.mjs';
import { formatHashrate, formatPosci, shortAddr, formatDuration } from '../lib/format.mjs';

export class Dashboard {
  constructor({ minerAddress, mode }) {
    this.minerAddress = minerAddress;
    this.mode         = mode;          // 'cpu' | 'gpu' | 'hybrid'
    this.startedAt    = Date.now();
    this.state = {
      cpuRate: 0, gpuRate: 0,
      reward: 0n, difficulty: 0n, remaining: 0n, epoch: 0n,
      poolGate: false, timeGate: false, miningStartTime: 0,
      networkHashrate: 0,
      myMined: 0n, myBalance: 0n,
      hits: [],
      lastTx: null, lastTxStatus: null,
      pendingNote: '',     // shown when we have a buffered solution waiting for gates
    };
    this.tty = process.stdout.isTTY;
    this._timer = null;
    this._lastLines = 0;
  }

  update(patch) {
    Object.assign(this.state, patch);
  }

  pushHit({ source, nonce, digest, reward, txHash, status }) {
    this.state.hits.unshift({
      source, nonce, digest, reward, txHash, status,
      at: new Date().toISOString().slice(11, 19),
    });
    this.state.hits = this.state.hits.slice(0, 8);
  }

  start() {
    if (!this.tty) {
      this._timer = setInterval(() => this._oneLine(), 5000);
      return;
    }
    process.stdout.write('\x1b[?25l'); // hide cursor
    this._timer = setInterval(() => this._render(), 1000);
    process.on('exit', () => process.stdout.write('\x1b[?25h\n'));
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    process.stdout.write('\x1b[?25h\n');
  }

  _oneLine() {
    const s = this.state;
    const total = s.cpuRate + s.gpuRate;
    console.log(`[${new Date().toISOString().slice(11,19)}] miner=${shortAddr(this.minerAddress,5)} hashrate=${formatHashrate(total)} epoch=${s.epoch} mined=${formatPosci(s.myMined,0)} POSCI`);
  }

  _render() {
    const s = this.state;
    const lines = [];
    const total = s.cpuRate + s.gpuRate;
    const elapsed = formatDuration((Date.now() - this.startedAt) / 1000);

    const canMine = s.timeGate && s.poolGate;
    const phase = canMine ? c.green().bold(' · LIVE') : c.yellow().bold(' · PRE-WARM');

    lines.push('');
    lines.push(c.bold().cyan('  POSCI miner') + c.dim(` · ${this.mode.toUpperCase()} · ${elapsed}`) + phase);
    lines.push(c.dim('  ─────────────────────────────────────────────────────────────'));
    lines.push(`  ${c.dim('Miner   ')}  ${c.bold(this.minerAddress)}`);
    lines.push(`  ${c.dim('Status  ')}  ` +
      (s.timeGate ? c.green('time ✓') : c.yellow(`time ⏳ opens ${new Date(s.miningStartTime*1000).toLocaleString()}`)) +
      ' · ' +
      (s.poolGate ? c.green('pool ✓') : c.yellow('pool ⏳ waiting on genesis cap')));
    if (!canMine) {
      lines.push(`  ${c.dim('         ')}  ${c.dim('hashing locally to pre-warm — NOT submitting tx until gates open')}`);
    }
    if (s.pendingNote) {
      lines.push(`  ${c.cyan(s.pendingNote)}`);
    }
    lines.push('');

    // Hashrate panel
    lines.push(c.bold('  Hashrate'));
    lines.push(`  ${c.dim('CPU     ')}  ${c.bold(formatHashrate(s.cpuRate)).padEnd(20)}`);
    lines.push(`  ${c.dim('GPU     ')}  ${c.bold(formatHashrate(s.gpuRate)).padEnd(20)}`);
    lines.push(`  ${c.dim('Total   ')}  ${c.bold().green(formatHashrate(total))}`);
    lines.push(`  ${c.dim('Network ')}  ~${formatHashrate(s.networkHashrate)}  ${c.dim('(implied by difficulty)')}`);
    lines.push('');

    // Network panel
    lines.push(c.bold('  Network'));
    lines.push(`  ${c.dim('Difficulty')}     ${s.difficulty.toLocaleString()}`);
    lines.push(`  ${c.dim('Reward    ')}     ${formatPosci(s.reward, 0)} POSCI/block`);
    lines.push(`  ${c.dim('Epoch     ')}     ${s.epoch}`);
    lines.push(`  ${c.dim('Remaining ')}     ${formatPosci(s.remaining, 0)} POSCI`);
    lines.push('');

    // My balance
    lines.push(c.bold('  My account'));
    lines.push(`  ${c.dim('Balance ')}      ${c.bold(formatPosci(s.myBalance, 4))} POSCI`);
    lines.push(`  ${c.dim('Mined this run')} ${c.bold(formatPosci(s.myMined, 4))} POSCI`);
    lines.push('');

    // Recent hits
    lines.push(c.bold('  Recent hits'));
    if (s.hits.length === 0) {
      lines.push(`  ${c.dim('(none yet — hashrate × difficulty determines expected wait)')}`);
    } else {
      for (const h of s.hits) {
        const stat = h.status === 'success' ? c.green('✓') :
                     h.status === 'pending' ? c.yellow('…') :
                     h.status === 'failed'  ? c.red('✗') : c.dim('?');
        lines.push(`  ${stat} ${c.dim(h.at)} ${h.source.toUpperCase().padEnd(3)} +${formatPosci(h.reward||0n,0).padStart(5)} POSCI ${c.dim(h.txHash ? h.txHash.slice(0,10)+'…' : '')}`);
      }
    }
    lines.push('');
    lines.push(c.dim('  Ctrl+C to stop'));

    // Move cursor up to overwrite previous frame
    if (this._lastLines > 0) process.stdout.write(`\x1b[${this._lastLines}A`);
    for (const ln of lines) {
      process.stdout.write('\x1b[2K');     // clear line
      process.stdout.write(ln + '\n');
    }
    this._lastLines = lines.length;
  }
}
