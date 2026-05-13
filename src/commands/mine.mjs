// `posci-miner mine` — start mining with CPU / GPU / hybrid.

import { availableParallelism } from 'node:os';
import { randomBytes } from 'node:crypto';

import { resolveAccount } from '../lib/wallet.mjs';
import { makePublicClient, makeWalletClient, readMiningState, readPosciBalance, submitMine } from '../lib/chain.mjs';
import { MiningManager } from '../mining/manager.mjs';
import { Dashboard } from '../ui/dashboard.mjs';
import { log, c } from '../lib/log.mjs';
import { formatPosci, formatHashrate } from '../lib/format.mjs';

export function registerMineCommand(program) {
  program.command('mine')
    .description('start mining POSCI (CPU / GPU / hybrid)')
    .option('--cpu [n]',   'use n CPU workers (default: number of cores)')
    .option('--gpu [n]',   'use GPU with n workgroups per dispatch (1-1024, default: 64). Requires Chrome.')
    .option('--hybrid',    'use both CPU and GPU')
    .option('--rpc <url>', 'Ethereum RPC URL (or POSCI_RPC env)')
    .option('--wallet <name>', 'local wallet name (use `wallet new` to create one)')
    .option('--password <pw>', 'wallet password (or POSCI_PASSWORD env)')
    .option('--key <0x...>', 'raw private key (skip local wallet store; use with care)')
    .option('--chrome <path>', 'path to chrome binary (or POSCI_CHROME_PATH env)')
    .option('--no-dashboard', 'plain log mode instead of full TUI')
    .option('--refresh <sec>', 'how often to re-poll chain state', '12')
    .action(async (opts) => {
      // ── Resolve auth + mode ────────────────────────────────────────────
      let acct;
      try { acct = resolveAccount(opts); }
      catch (e) { log.err(e.message); process.exit(1); }

      let cpuN = 0, gpuN = 0;
      const allCores = availableParallelism();

      if (opts.hybrid) {
        cpuN = Math.max(1, allCores - 1);
        gpuN = 64;
      } else if (opts.gpu !== undefined) {
        gpuN = Number(opts.gpu === true ? 64 : opts.gpu);
        if (opts.cpu !== undefined) cpuN = Number(opts.cpu === true ? allCores : opts.cpu);
      } else if (opts.cpu !== undefined) {
        cpuN = Number(opts.cpu === true ? allCores : opts.cpu);
      } else {
        // Default: CPU with all cores
        cpuN = allCores;
      }

      cpuN = Math.max(0, Math.min(64,  cpuN));
      gpuN = Math.max(0, Math.min(1024, gpuN));

      const mode = (cpuN > 0 && gpuN > 0) ? 'hybrid' : (gpuN > 0 ? 'gpu' : 'cpu');

      log.banner(c.bold().cyan('  POSCI miner'));
      log.info(`  miner: ${acct.address}  (${acct.source})`);
      log.info(`  mode : ${mode.toUpperCase()}  (cpu=${cpuN}, gpu=${gpuN})`);

      const pub    = makePublicClient(opts.rpc);
      const wallet = makeWalletClient(opts.rpc, acct.privateKey);

      // ── Initial chain pull ─────────────────────────────────────────────
      let chain = await readMiningState(pub);
      if (!chain.canMine) {
        log.warn(`Mining is not yet open:`);
        log.warn(`  time gate ${chain.timeGateOpen ? '✓' : '⏳'}  pool gate ${chain.poolGateOpen ? '✓' : '⏳'}`);
        log.info(`  CLI will wait and check every ${opts.refresh}s.`);
      }

      const myMinedAtStart = await readPosciBalance(pub, acct.address);
      let myMinedRun = 0n;

      const dash = new Dashboard({ minerAddress: acct.address, mode });
      dash.update({
        difficulty:      chain.difficulty,
        reward:          chain.miningReward,
        remaining:       chain.remainingSupply,
        epoch:           chain.epochCount,
        poolGate:        chain.poolGateOpen,
        timeGate:        chain.timeGateOpen,
        miningStartTime: chain.miningStartTime,
        networkHashrate: chain.networkHashrate,
        myBalance:       myMinedAtStart,
      });

      if (opts.dashboard !== false) dash.start();

      // ── Mining manager ─────────────────────────────────────────────────
      const startNonce = BigInt('0x' + randomBytes(8).toString('hex'));
      const mgr = new MiningManager({
        minerAddress: acct.address,
        cpuWorkers:   cpuN,
        gpuPower:     gpuN,
        gpuChromePath: opts.chrome,
      });
      mgr.on('error', ({ source, error }) => log.warn(`[${source}] ${error.message ?? error}`));
      mgr.on('stats', ({ cpu, gpu }) => dash.update({ cpuRate: cpu.hashrate, gpuRate: gpu.hashrate }));
      mgr.on('hit', async ({ source, nonce, digest }) => {
        // Auto-submit. The contract verifies digest with msg.sender — if our
        // wallet matches what the worker hashed against, it'll succeed.
        dash.pushHit({ source, nonce: '0x'+nonce.toString(16), digest, reward: chain.miningReward, status: 'pending' });
        try {
          const txHash = await submitMine(wallet, pub, nonce, digest);
          dash.pushHit({ source, nonce: '0x'+nonce.toString(16), digest, reward: chain.miningReward, txHash, status: 'pending' });
          const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
          if (receipt.status === 'success') {
            myMinedRun += chain.miningReward;
            const bal = await readPosciBalance(pub, acct.address);
            dash.pushHit({ source, nonce: '0x'+nonce.toString(16), digest, reward: chain.miningReward, txHash, status: 'success' });
            dash.update({ myMined: myMinedRun, myBalance: bal });
          } else {
            dash.pushHit({ source, nonce: '0x'+nonce.toString(16), digest, reward: 0n, txHash, status: 'failed' });
          }
        } catch (e) {
          dash.pushHit({ source, nonce: '0x'+nonce.toString(16), digest, reward: 0n, status: 'failed' });
        }
      });

      await mgr.start({
        challenge:  chain.challengeNumber,
        target:     chain.miningTarget,
        startNonce,
      });

      // ── Periodic chain refresh: detect new challenge / target ─────────
      const refreshSec = Math.max(3, Number(opts.refresh));
      const refreshTimer = setInterval(async () => {
        try {
          const fresh = await readMiningState(pub);
          // If challenge changed, we need to swap jobs to the new one
          if (fresh.challengeNumber !== chain.challengeNumber || fresh.miningTarget !== chain.miningTarget) {
            mgr.setJob({
              challenge: fresh.challengeNumber,
              target:    fresh.miningTarget,
              startNonce: BigInt('0x' + randomBytes(8).toString('hex')),
            });
          }
          chain = fresh;
          dash.update({
            difficulty:      chain.difficulty,
            reward:          chain.miningReward,
            remaining:       chain.remainingSupply,
            epoch:           chain.epochCount,
            poolGate:        chain.poolGateOpen,
            timeGate:        chain.timeGateOpen,
            miningStartTime: chain.miningStartTime,
            networkHashrate: chain.networkHashrate,
          });
        } catch { /* ignore transient RPC errors */ }
      }, refreshSec * 1000);

      // ── Graceful exit ──────────────────────────────────────────────────
      const cleanup = () => {
        clearInterval(refreshTimer);
        mgr.stop();
        dash.stop();
        log.banner(c.bold('  Stopped.'));
        log.info(`  Hashes computed this run: ${(mgr.cpuStats.totalHashes + mgr.gpuStats.totalHashes).toString()}`);
        log.info(`  POSCI mined this run    : ${formatPosci(myMinedRun, 4)}`);
        process.exit(0);
      };
      process.on('SIGINT',  cleanup);
      process.on('SIGTERM', cleanup);
    });
}
