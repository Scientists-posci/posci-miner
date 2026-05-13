#!/usr/bin/env node
//
//  posci-miner — CLI miner for POSCI (Proof of Scientist) on Ethereum mainnet
//

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerWalletCommands } from '../src/commands/wallet.mjs';
import { registerMineCommand }    from '../src/commands/mine.mjs';
import { registerStatusCommand }  from '../src/commands/status.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

const program = new Command();
program
  .name('posci-miner')
  .description('CLI miner for POSCI (Proof of Scientist) on Ethereum mainnet.\n  CPU + WebGPU + hybrid modes. Local encrypted wallet store.')
  .version(pkg.version, '-v, --version', 'show version')
  .addHelpText('after', `
Examples:
  $ posci-miner wallet new alice --password mypw
  $ posci-miner status --wallet alice --password mypw
  $ posci-miner mine --wallet alice --password mypw --hybrid
  $ posci-miner mine --key 0xabc... --cpu 8
  $ posci-miner mine --wallet alice --password mypw --gpu 256

Live data:  https://scientistdapp.online
Source:     https://github.com/aiyalxn/posci-miner
`);

registerWalletCommands(program);
registerMineCommand(program);
registerStatusCommand(program);

program.parseAsync(process.argv).catch((e) => {
  console.error('FATAL:', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
