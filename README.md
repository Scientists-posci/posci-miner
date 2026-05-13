<div align="center">

<img src="docs/logo.png" alt="POSCI logo" width="160" height="160" />

# posci-miner

**CLI miner for [POSCI](https://scientistdapp.online) — Proof of Scientist · Ethereum mainnet**

`CPU + WebGPU + hybrid · Local encrypted wallet · Anti-MEV by design`

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-339933)](https://nodejs.org)
[![Chain](https://img.shields.io/badge/chain-Ethereum%20mainnet-627EEA)](https://etherscan.io/token/0xD020e5E5c2724B2661C2FEF9AE878f49410a8B77)

</div>

---

## What is POSCI?

[**POSCI**](https://scientistdapp.online) is a **21,000,000-cap, owner-less, PoW-mined ERC-20** on Ethereum mainnet. 95% of the supply is distributed via on-chain Proof-of-Work mining (Bitcoin-style halving + difficulty retarget). The mining contract is **fully renounced** — there is no admin, no mint function, no upgrade proxy. The launch LP is permanently burned to `0x000…dEaD`.

The PoW digest is `keccak256(challenge ‖ msg.sender ‖ nonce)` — your wallet address is **inside the hash**. A copied nonce produces a different digest for any other miner, so **MEV bots cannot snipe your nonce from the mempool**.

| | |
|---|---|
| Token contract  | [`0xD020e5E5c2724B2661C2FEF9AE878f49410a8B77`](https://etherscan.io/token/0xD020e5E5c2724B2661C2FEF9AE878f49410a8B77) |
| Mining contract | [`0x9EAdD7dF7701e03d07c3727EC1ba816C2C9De936`](https://etherscan.io/address/0x9EAdD7dF7701e03d07c3727EC1ba816C2C9De936) |
| Genesis contract| [`0x7bC1520Da49Cd56D5BE11aA77650cA998951459d`](https://etherscan.io/address/0x7bC1520Da49Cd56D5BE11aA77650cA998951459d) |
| Site / web miner| https://scientistdapp.online |

---

## Install

```bash
# Requires Node.js ≥ 18.17
npm install -g posci-miner

# Or run without installing:
npx posci-miner --help
```

> **GPU mining** requires Google Chrome / Chromium / Edge installed locally
> (the CLI launches a headless instance for the WebGPU compute kernel).
> Set `POSCI_CHROME_PATH=/path/to/chrome` if it's not in a default location.

---

## Quick start

```bash
# 1. Create a fresh wallet (encrypted under ~/.posci/wallets/)
posci-miner wallet new alice --password mypw

#    → prints address + private key (private key shown once, save it)
#    → send some ETH to that address to pay for mine() tx fees (~0.001 ETH/win)

# 2. Check network status
posci-miner status --wallet alice --password mypw

# 3. Start mining
posci-miner mine --wallet alice --password mypw --hybrid
```

That's it. The CLI auto-submits successful PoW solutions and shows a live dashboard with hashrate, network difficulty, and recent hits.

---

## Commands

### `wallet new <name>`
Generate a fresh wallet, encrypt the private key with `--password` (AES-256-GCM, PBKDF2 250k rounds), store under `~/.posci/wallets/<name>.json`.

```bash
posci-miner wallet new alice --password mypw
```

### `wallet list` / `wallet show <name>` / `wallet import <name>`
Manage local encrypted keystores. `wallet show --private` reveals the decrypted private key (requires password).

### `mine`
Start mining with one of three engines:

| Flag | Meaning |
|---|---|
| `--cpu [n]` | n CPU worker threads (default: all cores) |
| `--gpu [n]` | n WebGPU workgroups per dispatch (default: 64). Requires Chrome. |
| `--hybrid` | both CPU and GPU concurrently |

Examples:

```bash
# Pure CPU, all cores
posci-miner mine --wallet alice --password mypw

# Pure CPU, 4 workers
posci-miner mine --wallet alice --password mypw --cpu 4

# Pure GPU (one Chrome process)
posci-miner mine --wallet alice --password mypw --gpu 256

# Hybrid: CPU on N-1 cores + GPU
posci-miner mine --wallet alice --password mypw --hybrid

# Use raw private key instead of local wallet store
posci-miner mine --key 0xabcdef... --hybrid

# Use a specific RPC (defaults to a public Ethereum node)
posci-miner mine --wallet alice --password mypw --rpc https://eth-mainnet.g.alchemy.com/v2/<key> --hybrid

# Plain log mode (no full TUI — useful for CI / nohup)
posci-miner mine --wallet alice --password mypw --no-dashboard
```

### `status`
Snapshot the on-chain mining state and (optionally) your account balance.

```bash
posci-miner status                                      # network only
posci-miner status --address 0xYourAddress              # + balance
posci-miner status --wallet alice --password mypw       # + balance from local wallet
```

---

## Live dashboard

When stdout is a TTY, the `mine` command renders a live dashboard:

```
  POSCI miner · HYBRID · 3m 12s
  ─────────────────────────────────────────────────────────────
  Miner     0x9Fa33C79C8bc2Ad785fdE6D10608dB97A95093fa
  Status    time ✓ · pool ✓

  Hashrate
  CPU       2.4 MH/s
  GPU       18.7 MH/s
  Total     21.1 MH/s
  Network   ~134 MH/s  (implied by difficulty)

  Network
  Difficulty     1,920
  Reward         1,000 POSCI/block
  Epoch          47
  Remaining      19,953,000 POSCI

  My account
  Balance        2,000.0000 POSCI
  Mined this run 1,000.0000 POSCI

  Recent hits
  ✓ 14:23:01 GPU +1000 POSCI 0xa1b2c3d4…

  Ctrl+C to stop
```

---

## How it works

1. **CPU engine** — N Node.js `worker_threads`, each running `js-sha3.keccak_256` in a tight loop with a unique stride to cover disjoint nonce ranges.
2. **GPU engine** — spawns headless Chrome with our WGSL compute shader (same one the web frontend uses). Chrome posts hits + hashrate over a localhost WebSocket back to the CLI. Reuses the battle-tested shader in `src/mining/keccak256.wgsl.mjs`.
3. **Hybrid** — both run concurrently with disjoint nonce strides so they never duplicate work. Dedup at the manager catches the rare cross-engine collision.
4. **Auto-submit** — when any engine finds a valid digest, the CLI immediately calls `mine(nonce, digest)` on the contract from your wallet. Reward lands in your wallet.
5. **Auto-refresh** — every 12s (configurable), the CLI polls the chain for new challenge / target / difficulty and hot-swaps the job into running workers.

The hash that the contract verifies is exactly:
```
keccak256(abi.encodePacked(challengeNumber, msg.sender, nonce))
```
Both engines produce digests with **your wallet's address** as `msg.sender`. That's why **only YOU** can submit a valid mine() tx — anyone copying your nonce from the mempool would get a different digest (since their msg.sender is different) and the contract would revert.

---

## Wallet security

Wallets created with `wallet new`:
- Stored under `~/.posci/wallets/<name>.json` (POSIX 0600 perms)
- Private key encrypted with AES-256-GCM
- Key derivation: PBKDF2-HMAC-SHA256, 250,000 iterations, 16-byte random salt
- Plaintext private key only held in memory while mining

If you lose the password, the wallet is unrecoverable. Back up the keystore JSON + remember the password.

You can also pass a private key directly with `--key 0x...` for ephemeral use (e.g., a dedicated mining wallet), or set `POSCI_PRIVATE_KEY` / `POSCI_WALLET` + `POSCI_PASSWORD` env vars.

---

## Realistic expectations

POSCI mining is competitive — at any given moment, the network hashrate × difficulty determines your expected wait. Some napkin math:

| Your hashrate | Network hashrate | Expected wait per block (1000 POSCI) |
|---|---|---|
| 1 MH/s   | 100 MH/s | ~10 minutes |
| 10 MH/s  | 100 MH/s | ~1 minute   |
| 100 MH/s | 1 GH/s   | ~10 minutes |

Use the live `posci-miner status` to see current network hashrate.

Each successful `mine()` tx costs ETH gas (~0.0005-0.005 ETH at typical mainnet rates). At low POSCI prices, ensure your reward × POSCI_USD_price > tx_gas_cost.

---

## Troubleshooting

**"Mining is not yet open"** — both gates (time + pool) must be open. Time gate opens 12h after deploy. Pool gate opens after the genesis sale fills 0.5 ETH. Check live status: https://scientistdapp.online/stats

**"No Chrome/Edge/Chromium binary found"** — install Chrome or set `POSCI_CHROME_PATH`. GPU mode needs a recent Chrome (≥113) for WebGPU.

**"WebGPU NOT available in this Chrome"** — your Chrome was started without GPU access. On Linux, ensure you have GPU drivers + try `--enable-features=Vulkan` flag (the CLI passes this automatically).

**Hits show ✗ failed** — the most common cause is the challenge having rotated between when your worker hashed and when your tx landed. The CLI auto-detects this via periodic chain reads and hot-swaps. If you see persistent failures, check that your wallet has enough ETH for gas.

**"DifficultyNotMet"** — your engine's local target was stale (chain difficulty went up). The CLI will auto-correct on the next 12s refresh.

---

## Architecture

```
posci-miner/
├── bin/posci-miner.mjs              CLI entry (commander)
├── src/
│   ├── commands/                    wallet · mine · status
│   ├── lib/
│   │   ├── chain.mjs                viem clients, mining contract calls
│   │   ├── wallet.mjs               local encrypted keystore (AES-256-GCM)
│   │   ├── config.mjs               contract addresses + RPCs
│   │   ├── format.mjs               hashrate / POSCI / duration formatters
│   │   └── log.mjs                  colored logging
│   ├── mining/
│   │   ├── manager.mjs              orchestrator (CPU + GPU + dedup)
│   │   ├── cpu-worker.mjs           Node worker_threads CPU keccak
│   │   ├── gpu-driver.mjs           spawns headless Chrome for WebGPU
│   │   └── keccak256.wgsl.mjs       the WGSL compute shader
│   └── ui/dashboard.mjs             live TUI dashboard
└── docs/                            logo assets
```

---

## Contributing

PRs welcome. Open an issue for design discussion before significant changes.

Please don't submit token-shilling spam — this repo is for the miner only. For protocol questions, [open an issue](https://github.com/aiyalxn/posci-miner/issues) or come to [@scientistsdapp](https://x.com/scientistsdapp) on X.

---

## License

[MIT](LICENSE) © 2026 Proof of Scientist contributors

This software is provided as-is. Mining cryptocurrency may be regulated in your jurisdiction. You are responsible for understanding and complying with applicable laws.

The POSCI smart contracts are immutable, non-custodial, and were deployed by an EOA with no admin powers. The contributors of this miner have no control over the protocol or any user funds.
