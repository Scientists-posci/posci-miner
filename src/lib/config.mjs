// On-chain constants for the live POSCI deployment.
// These addresses match the verified contracts at scientistdapp.online.

export const POSCI_TOKEN   = '0xD020e5E5c2724B2661C2FEF9AE878f49410a8B77';
export const POSCI_MINING  = '0x9EAdD7dF7701e03d07c3727EC1ba816C2C9De936';
export const POSCI_GENESIS = '0x7bC1520Da49Cd56D5BE11aA77650cA998951459d';

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
