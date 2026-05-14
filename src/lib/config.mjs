// On-chain constants for the live POSCI deployment.
// These addresses match the verified contracts at scientistdapp.online.

export const POSCI_TOKEN   = '0xFbcF59DE93B4c62e0EEe21280c9EAA75AFb1E26c';
export const POSCI_MINING  = '0x37f9663Ef548b8192a73F54930D8Cd40ea1D1eAa';
export const POSCI_GENESIS = '0x77Ba7F769341948cdE3C085d39B2C4ec572649Dd';

// Public RPC fallbacks. Override with --rpc on the CLI or POSCI_RPC env var.
export const PUBLIC_RPCS = [
  'https://ethereum.publicnode.com',
  'https://eth.llamarpc.com',
  'https://eth.merkle.io',
  'https://1rpc.io/eth',
];

// Difficulty / supply constants from the contract — copy here so we can
// compute schedule without an extra RPC call.
export const TOTAL_MINING_SUPPLY = 20_000_000n * 10n ** 18n;
export const INITIAL_REWARD      = 1_000n * 10n ** 18n;
export const HALVING_INTERVAL    = 10_000n;
export const MAX_HALVINGS        = 64n;
export const MAXIMUM_TARGET      = 1n << 234n;
export const TARGET_INTERVAL     = 60n;
export const BLOCKS_PER_READJUST = 1024n;
