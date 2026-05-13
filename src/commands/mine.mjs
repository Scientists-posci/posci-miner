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

      // ── Hit handling — gated on chain.canMine ─────────────────────────
      // Workers don't know about gates; they just hash. The check that
      // matters is "is the contract actually willing to accept mine() right
      // now?" — driven by chain.canMine (time gate AND pool gate both open).
      //
      // If gates are closed, we BUFFER the most recent valid solution
      // (against the current challenge) and re-attempt as soon as gates
      // open. This gets you the FIRST submission window without burning gas
      // on guaranteed-revert txs.
      let pendingHit = null;
      let busy = false;       // ensure only one in-flight tx at a time

      async function trySubmit(hit) {
        if (busy) return;
        if (!chain.canMine) {
          pendingHit = hit;
          return;
        }
        busy = true;
        const nonceHex = '0x' + hit.nonce.toString(16);
        dash.pushHit({ source: hit.source, nonce: nonceHex, digest: hit.digest,
                       reward: chain.miningReward, status: 'pending' });
        try {
          const txHash = await submitMine(wallet, pub, hit.nonce, hit.digest);
          dash.pushHit({ source: hit.source, nonce: nonceHex, digest: hit.digest,
                         reward: chain.miningReward, txHash, status: 'pending' });
          const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
          if (receipt.status === 'success') {
            myMinedRun += chain.miningReward;
            const bal = await readPosciBalance(pub, acct.address);
            dash.pushHit({ source: hit.source, nonce: nonceHex, digest: hit.digest,
                           reward: chain.miningReward, txHash, status: 'success' });
            dash.update({ myMined: myMinedRun, myBalance: bal });
          } else {
            dash.pushHit({ source: hit.source, nonce: nonceHex, digest: hit.digest,
                           reward: 0n, txHash, status: 'failed' });
          }
        } catch (e) {
          dash.pushHit({ source: hit.source, nonce: nonceHex, digest: hit.digest,
                         reward: 0n, status: 'failed' });
          log.warn(`submit error: ${e.shortMessage ?? e.message ?? e}`);
        } finally {
          busy = false;
          pendingHit = null;
        }
      }

      mgr.on('hit', (hit) => {
        if (chain.canMine) {
          // Gates open — submit immediately
          trySubmit(hit).catch(() => {});
        } else {
          // Gates closed — keep the most recent solution for current challenge.
          // Don't try to submit yet (would burn gas on guaranteed revert).
          pendingHit = hit;
        }
      });

      // Surface "we have a buffered solution waiting for gates" in the dashboard
      const pendingTimer = setInterval(() => {
        dash.update({
          pendingNote: (!chain.canMine && pendingHit)
            ? `★ buffered solution ready — will submit the moment gates open`
            : '',
        });
      }, 1000);

      await mgr.start({
        challenge:  chain.challengeNumber,
        target:     chain.miningTarget,
        startNonce,
      });

      // ── Periodic chain refresh: detect new challenge / target / gates ──
      const refreshSec = Math.max(3, Number(opts.refresh));
      const refreshTimer = setInterval(async () => {
        try {
          const fresh = await readMiningState(pub);
          const gatesJustOpened = fresh.canMine && !chain.canMine;
          const challengeRotated = fresh.challengeNumber !== chain.challengeNumber
                                || fresh.miningTarget    !== chain.miningTarget;

          if (challengeRotated) {
            mgr.setJob({
              challenge: fresh.challengeNumber,
              target:    fresh.miningTarget,
              startNonce: BigInt('0x' + randomBytes(8).toString('hex')),
            });
            // Old buffered solution is now invalid (different challenge)
            pendingHit = null;
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

          // Race-window: gates just flipped open AND we have a buffered solution
          if (gatesJustOpened && pendingHit) {
            log.ok(`Gates opened — submitting buffered solution from pre-warm period`);
            trySubmit(pendingHit).catch(() => {});
          }
        } catch { /* ignore transient RPC errors */ }
      }, refreshSec * 1000);

      // ── Graceful exit ──────────────────────────────────────────────────
      const cleanup = () => {
        clearInterval(refreshTimer);
        clearInterval(pendingTimer);
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
