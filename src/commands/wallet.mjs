// Wallet subcommands.

import { walletNew, walletLoad, walletImport, listWallets, walletDir } from '../lib/wallet.mjs';
import { c, log } from '../lib/log.mjs';
import { shortAddr } from '../lib/format.mjs';

export function registerWalletCommands(program) {
  const w = program.command('wallet').description('manage local encrypted wallets');

  w.command('new')
    .description('generate a new wallet, encrypted with --password')
    .argument('<name>', 'wallet name (alphanumeric)')
    .option('--password <pw>', 'password for the keystore (or POSCI_PASSWORD env)')
    .action((name, opts) => {
      try {
        const pw = opts.password || process.env.POSCI_PASSWORD;
        if (!pw) { log.err('--password required (or set POSCI_PASSWORD env)'); process.exit(1); }
        const r = walletNew(name, pw);
        log.banner(c.green().bold('  ✓ Wallet created'));
        console.log(`    ${c.dim('name      ')} ${r.name}`);
        console.log(`    ${c.dim('address   ')} ${c.bold(r.address)}`);
        console.log(`    ${c.dim('keystore  ')} ${r.path}`);
        console.log(`    ${c.dim('private   ')} ${c.yellow(r.privateKey)} ${c.dim('(shown once)')}`);
        console.log('');
        console.log(c.yellow('  ⚠ Save the private key OFFLINE — it will not be shown again unless you decrypt.'));
        console.log(`  ${c.dim('Send some ETH to')} ${c.bold(r.address)} ${c.dim('to pay for mine() tx fees.')}`);
      } catch (e) { log.err(e.message); process.exit(1); }
    });

  w.command('list')
    .description('list local wallets')
    .action(() => {
      const ws = listWallets();
      if (ws.length === 0) {
        log.info(`No wallets at ${walletDir()}.`);
        log.info('Run: posci-miner wallet new <name> --password <pw>');
        return;
      }
      log.banner(c.bold(`  Local wallets (${walletDir()})`));
      log.table(ws.map(w => ({
        name: w.name, address: w.address, created: w.createdAt.slice(0, 19),
      })));
    });

  w.command('show')
    .description('reveal address (and optionally private key) of a stored wallet')
    .argument('<name>', 'wallet name')
    .option('--password <pw>', 'password (required to reveal private key)')
    .option('--private', 'also show the decrypted private key')
    .action((name, opts) => {
      try {
        if (opts.private && !opts.password && !process.env.POSCI_PASSWORD) {
          log.err('--password required to reveal private key');
          process.exit(1);
        }
        if (opts.private) {
          const pw = opts.password || process.env.POSCI_PASSWORD;
          const w = walletLoad(name, pw);
          console.log(`address    : ${w.address}`);
          console.log(`privateKey : ${w.privateKey}`);
        } else {
          const ws = listWallets().find(w => w.name === name);
          if (!ws) { log.err(`wallet '${name}' not found`); process.exit(1); }
          console.log(`address: ${ws.address}`);
        }
      } catch (e) { log.err(e.message); process.exit(1); }
    });

  w.command('import')
    .description('import an external private key into the local store')
    .argument('<name>', 'wallet name to save under')
    .requiredOption('--key <0x...>', '0x-prefixed 64-hex private key')
    .option('--password <pw>', 'encryption password (or POSCI_PASSWORD env)')
    .action((name, opts) => {
      try {
        const pw = opts.password || process.env.POSCI_PASSWORD;
        if (!pw) { log.err('--password required'); process.exit(1); }
        const r = walletImport(name, opts.key, pw);
        log.ok(`Imported ${r.address} as '${r.name}' → ${r.path}`);
      } catch (e) { log.err(e.message); process.exit(1); }
    });
}
