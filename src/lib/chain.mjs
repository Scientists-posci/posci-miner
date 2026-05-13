// Thin viem wrapper for POSCI mining contract reads + the mine() write.

import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

import { POSCI_TOKEN, POSCI_MINING, PUBLIC_RPCS, MAXIMUM_TARGET } from './config.mjs';

const TOKEN_ABI = [
  { type:'function', name:'balanceOf', stateMutability:'view',
    inputs:[{type:'address',name:'a'}], outputs:[{type:'uint256'}] },
  { type:'function', name:'symbol', stateMutability:'view', inputs:[], outputs:[{type:'string'}] },
];

const MINING_ABI = [
  { type:'function', name:'mine', stateMutability:'nonpayable',
    inputs:[{type:'uint256',name:'nonce'},{type:'bytes32',name:'challengeDigest'}], outputs:[] },
  { type:'function', name:'challengeNumber',     stateMutability:'view', inputs:[], outputs:[{type:'bytes32'}] },
  { type:'function', name:'miningTarget',        stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
  { type:'function', name:'getMiningReward',     stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
  { type:'function', name:'getMiningDifficulty', stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
  { type:'function', name:'getRemainingSupply',  stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
  { type:'function', name:'epochCount',          stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
  { type:'function', name:'tokensMinted',        stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
  { type:'function', name:'miningStartTime',     stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
  { type:'function', name:'poolGateOpen',        stateMutability:'view', inputs:[], outputs:[{type:'bool'}] },
];

export function makePublicClient(rpcUrl) {
  return createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl || process.env.POSCI_RPC || PUBLIC_RPCS[0]),
  });
}

export function makeWalletClient(rpcUrl, privateKey) {
  return createWalletClient({
    chain: mainnet,
    transport: http(rpcUrl || process.env.POSCI_RPC || PUBLIC_RPCS[0]),
    account: privateKeyToAccount(privateKey),
  });
}

/** Pull all mining state in one multicall. */
export async function readMiningState(publicClient) {
  const calls = [
    'challengeNumber','miningTarget','getMiningReward','getMiningDifficulty',
    'getRemainingSupply','epochCount','tokensMinted','miningStartTime','poolGateOpen',
  ].map(fn => ({ address: POSCI_MINING, abi: MINING_ABI, functionName: fn }));

  const r = await publicClient.multicall({ contracts: calls, allowFailure: false });
  const [challenge, target, reward, difficulty, remaining, epoch, minted, startTime, poolOpen] = r;

  const now = Math.floor(Date.now() / 1000);
  return {
    challengeNumber: challenge,
    miningTarget:    target,
    miningReward:    reward,
    difficulty,
    remainingSupply: remaining,
    epochCount:      epoch,
    tokensMinted:    minted,
    miningStartTime: Number(startTime),
    poolGateOpen:    poolOpen,
    timeGateOpen:    BigInt(now) >= startTime,
    canMine:         (BigInt(now) >= startTime) && poolOpen,
    /** Estimated network hashrate from current target. */
    networkHashrate: estimateNetworkHashrate(difficulty),
  };
}

export async function readPosciBalance(publicClient, address) {
  return await publicClient.readContract({
    address: POSCI_TOKEN, abi: TOKEN_ABI, functionName: 'balanceOf', args: [address],
  });
}

export async function submitMine(walletClient, publicClient, nonce, digest) {
  const hash = await walletClient.writeContract({
    address: POSCI_MINING, abi: MINING_ABI, functionName: 'mine', args: [nonce, digest],
  });
  // Don't await receipt here — caller decides
  return hash;
}

/**
 * Heuristic network hashrate from current difficulty.
 *   E[hashes/find] = 2^256 / target = 2^22 * difficulty   (since MAXIMUM_TARGET = 2^234)
 *   Hashrate at steady-state = E[hashes/find] / TARGET_INTERVAL
 */
export function estimateNetworkHashrate(difficulty, targetIntervalSec = 60) {
  if (difficulty === 0n) return 0;
  return Number(difficulty) * 2 ** 22 / targetIntervalSec;
}

export const ABIs = { TOKEN_ABI, MINING_ABI };
