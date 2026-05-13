// `posci-miner status` — one-shot snapshot of the network + your account.

import { makePublicClient, readMiningState, readPosciBalance } from '../lib/chain.mjs';
import { resolveAccount } from '../lib/wallet.mjs';
import { log, c } from '../lib/log.mjs';
import { formatHashrate, formatPosci, shortAddr, formatDuration } from '../lib/format.mjs';
import { POSCI_TOKEN, POSCI_MINING, POSCI_GENESIS } from '../lib/config.mjs';

export function registerStatusCommand(program) {
  program.command('status')
    .description('one-shot snapshot of POSCI mining contract + your account')
    .option('--rpc <url>', 'RPC URL (defaults to public endpoints)')
    .option('--wallet <name>', 'local wallet name')
    .option('--password <pw>', 'wallet password (or POSCI_PASSWORD env)')
    .option('--key <0x...>', 'use raw private key (skips local wallet store)')
    .option('--address <0x...>', 'just look up balance of this address (no auth)')
    .action(async (opts) => {
      const pub = makePublicClient(opts.rpc);
      log.banner(c.cyan().bold('  POSCI · network status'));
      try {
        const s = await readMiningState(pub);
        const lines = [
          ['Network',        'Ethereum mainnet (chainId 1)'],
          ['Mining contract', POSCI_MINING],
          ['Token',           POSCI_TOKEN],
          ['Genesis',         POSCI_GENESIS],
          ['',                ''],
          ['Time gate',       s.timeGateOpen ? c.green('OPEN ✓') : c.yellow(`opens ${new Date(s.miningStartTime*1000).toLocaleString()}`)],
          ['Pool gate',       s.poolGateOpen ? c.green('OPEN ✓') : c.yellow('CLOSED — waiting on genesis cap')],
          ['Mining live',     s.canMine ? c.green().bold('YES') : c.yellow('NO')],
          ['',                ''],
          ['Difficulty',      s.difficulty.toLocaleString()],
          ['Reward / block',  formatPosci(s.miningReward, 0) + ' POSCI'],
          ['Epoch',           s.epochCount.toString()],
          ['Mined so far',    formatPosci(s.tokensMinted, 0) + ' POSCI'],
          ['Remaining',       formatPosci(s.remainingSupply, 0) + ' POSCI'],
          ['Network hashrate ≈', formatHashrate(s.networkHashrate)],
        ];
        for (const [k, v] of lines) {
          if (k === '') console.log('');
          else console.log(`  ${c.dim(k.padEnd(18))} ${v}`);
        }

        let addr;
        if (opts.address) addr = opts.address;
        else {
          try { addr = resolveAccount(opts).address; } catch { /* no auth, skip */ }
        }
        if (addr) {
          const bal = await readPosciBalance(pub, addr);
          console.log('');
          console.log(`  ${c.dim('Your address  ')}     ${c.bold(addr)}`);
          console.log(`  ${c.dim('Your POSCI    ')}     ${c.bold(formatPosci(bal, 4))} POSCI`);
        }
        console.log('');
      } catch (e) {
        log.err(`Status failed: ${e.message}`); process.exit(1);
      }
    });
}
