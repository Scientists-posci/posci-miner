// Local wallet store. Keys are stored encrypted under ~/.posci/wallets/<name>.json
// using AES-256-GCM with PBKDF2-derived key (matches Geth keystore v3 spirit).
//
// Two paths:
//   - walletNew(name, password) → generate, return address
//   - walletLoad(name, password) → decrypt + return privateKey + address
//
// You can also pass a private key directly via --key on the CLI; in that case
// nothing is read or written from the store.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import {
  randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv,
} from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const STORE_DIR = process.env.POSCI_HOME || join(homedir(), '.posci', 'wallets');
const KDF_ITERS = 250_000;
const KDF_KEYLEN = 32;
const KDF_DIGEST = 'sha256';

function ensureDir() { mkdirSync(STORE_DIR, { recursive: true }); }
function walletPath(name) { return resolve(STORE_DIR, `${name}.json`); }

export function walletDir() { return STORE_DIR; }

export function listWallets() {
  if (!existsSync(STORE_DIR)) return [];
  return readdirSync(STORE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const name = f.replace(/\.json$/, '');
      const path = walletPath(name);
      const data = JSON.parse(readFileSync(path, 'utf8'));
      return { name, address: data.address, createdAt: data.createdAt, path };
    });
}

function encrypt(privateKey, password) {
  const salt = randomBytes(16);
  const iv   = randomBytes(12);
  const key  = pbkdf2Sync(password, salt, KDF_ITERS, KDF_KEYLEN, KDF_DIGEST);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: 'aes-256-gcm',
    kdf: { name: 'pbkdf2', iters: KDF_ITERS, keylen: KDF_KEYLEN, digest: KDF_DIGEST,
           salt: salt.toString('hex') },
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

function decrypt(payload, password) {
  if (payload.cipher !== 'aes-256-gcm') throw new Error('unsupported cipher');
  const salt = Buffer.from(payload.kdf.salt, 'hex');
  const iv   = Buffer.from(payload.iv, 'hex');
  const tag  = Buffer.from(payload.tag, 'hex');
  const key  = pbkdf2Sync(password, salt, payload.kdf.iters, payload.kdf.keylen, payload.kdf.digest);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/** Generate a new wallet, store under `name`, return { name, address, privateKey }. */
export function walletNew(name, password) {
  if (!name) throw new Error('wallet name required');
  if (!password) throw new Error('password required (pass --password or use POSCI_PASSWORD env)');
  ensureDir();
  if (existsSync(walletPath(name))) throw new Error(`wallet '${name}' already exists at ${walletPath(name)}`);

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const data = {
    name, address: account.address, createdAt: new Date().toISOString(),
    keystore: encrypt(privateKey, password),
  };
  writeFileSync(walletPath(name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return { name, address: account.address, privateKey, path: walletPath(name) };
}

/** Decrypt and return { name, address, privateKey } for an existing wallet. */
export function walletLoad(name, password) {
  if (!name) throw new Error('wallet name required');
  if (!password) throw new Error('password required (pass --password or use POSCI_PASSWORD env)');
  const path = walletPath(name);
  if (!existsSync(path)) throw new Error(`wallet '${name}' not found at ${path}`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const privateKey = decrypt(data.keystore, password);
  return { name, address: data.address, privateKey, path };
}

/** Import an external private key into the local store under `name`. */
export function walletImport(name, privateKey, password) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('private key must be 0x-prefixed 64-char hex');
  }
  if (!password) throw new Error('password required');
  ensureDir();
  if (existsSync(walletPath(name))) throw new Error(`wallet '${name}' already exists`);
  const account = privateKeyToAccount(privateKey);
  const data = {
    name, address: account.address, createdAt: new Date().toISOString(),
    keystore: encrypt(privateKey, password),
  };
  writeFileSync(walletPath(name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return { name, address: account.address, privateKey, path: walletPath(name) };
}

/**
 * Resolve an account from CLI flags. Priority:
 *   1. --key <0x...> direct private key                 (ephemeral, not stored)
 *   2. --wallet <name> + --password <p>                  (decrypt local store)
 *   3. POSCI_PRIVATE_KEY env var                         (ephemeral)
 *   4. POSCI_WALLET + POSCI_PASSWORD env vars            (load from store)
 *
 * Returns { address, privateKey, source }.
 */
export function resolveAccount({ key, wallet, password }) {
  if (key) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('--key must be 0x-prefixed 64-char hex');
    const a = privateKeyToAccount(key);
    return { address: a.address, privateKey: key, source: 'flag-key' };
  }
  if (wallet) {
    const pw = password || process.env.POSCI_PASSWORD;
    if (!pw) throw new Error('--password required when using --wallet (or set POSCI_PASSWORD)');
    const w = walletLoad(wallet, pw);
    return { address: w.address, privateKey: w.privateKey, source: `wallet:${wallet}` };
  }
  if (process.env.POSCI_PRIVATE_KEY) {
    const k = process.env.POSCI_PRIVATE_KEY;
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('POSCI_PRIVATE_KEY env: bad format');
    const a = privateKeyToAccount(k);
    return { address: a.address, privateKey: k, source: 'env-key' };
  }
  if (process.env.POSCI_WALLET && process.env.POSCI_PASSWORD) {
    const w = walletLoad(process.env.POSCI_WALLET, process.env.POSCI_PASSWORD);
    return { address: w.address, privateKey: w.privateKey, source: `env-wallet:${process.env.POSCI_WALLET}` };
  }
  throw new Error('No wallet configured. See: posci-miner wallet --help');
}
