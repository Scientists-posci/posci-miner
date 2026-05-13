/**
 * WGSL compute shader for Keccak-256 PoW mining.
 *
 * Each thread tries `perThread` consecutive nonces, building the 84-byte input:
 *   challenge (32 bytes) || miner (20 bytes) || nonce (32 bytes, big-endian, uint64 in low 8)
 *
 * Match against on-chain check:
 *   keccak256(abi.encodePacked(bytes32 challenge, address miner, uint256 nonce)) ≤ target
 *
 * State packing: each Keccak lane = vec2<u32> = (low_le_u32, high_le_u32),
 * so a 64-bit lane stores its bytes as 8 little-endian bytes spread across the two u32s.
 *
 * Verified by `lib/mining/gpu-miner.ts` self-test against js-sha3 on init.
 */
export const KECCAK256_WGSL = /* wgsl */`
struct Params {
  challenge: array<vec4<u32>, 2>,   // 8 LE u32 limbs of the challenge bytes
  miner:     array<vec4<u32>, 2>,   // 5 LE u32 limbs of the address (last 12 bytes ignored)
  target:    array<vec4<u32>, 2>,   // 8 BE u32 limbs of the mining target (uint256)
  baseNonce: vec2<u32>,             // (low, high) of the nonce origin for this dispatch
  perThread: u32,
  _pad:      u32,
};

struct Hit {
  nonceLo: u32,
  nonceHi: u32,
  _pad0:   u32,
  _pad1:   u32,
  digest:  array<vec4<u32>, 2>,     // 8 BE u32 limbs of the digest
};

struct Hits {
  count:   atomic<u32>,
  _p0:     u32,
  _p1:     u32,
  _p2:     u32,
  items:   array<Hit, 16>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> hits: Hits;

// ---------------- helpers ----------------

fn rotl64(v: vec2<u32>, n: u32) -> vec2<u32> {
  if (n == 0u) { return v; }
  if (n < 32u) {
    let lo = (v.x << n) | (v.y >> (32u - n));
    let hi = (v.y << n) | (v.x >> (32u - n));
    return vec2<u32>(lo, hi);
  }
  let m = n - 32u;
  if (m == 0u) { return vec2<u32>(v.y, v.x); }
  let lo = (v.y << m) | (v.x >> (32u - m));
  let hi = (v.x << m) | (v.y >> (32u - m));
  return vec2<u32>(lo, hi);
}

fn bswap32(v: u32) -> u32 {
  return ((v & 0xffu) << 24u)
       | ((v & 0xff00u) << 8u)
       | ((v & 0xff0000u) >> 8u)
       | ((v >> 24u) & 0xffu);
}

// Keccak round constants, RC[r] as (low, high)
const RC = array<vec2<u32>, 24>(
  vec2<u32>(0x00000001u, 0x00000000u),
  vec2<u32>(0x00008082u, 0x00000000u),
  vec2<u32>(0x0000808au, 0x80000000u),
  vec2<u32>(0x80008000u, 0x80000000u),
  vec2<u32>(0x0000808bu, 0x00000000u),
  vec2<u32>(0x80000001u, 0x00000000u),
  vec2<u32>(0x80008081u, 0x80000000u),
  vec2<u32>(0x00008009u, 0x80000000u),
  vec2<u32>(0x0000008au, 0x00000000u),
  vec2<u32>(0x00000088u, 0x00000000u),
  vec2<u32>(0x80008009u, 0x00000000u),
  vec2<u32>(0x8000000au, 0x00000000u),
  vec2<u32>(0x8000808bu, 0x00000000u),
  vec2<u32>(0x0000008bu, 0x80000000u),
  vec2<u32>(0x00008089u, 0x80000000u),
  vec2<u32>(0x00008003u, 0x80000000u),
  vec2<u32>(0x00008002u, 0x80000000u),
  vec2<u32>(0x00000080u, 0x80000000u),
  vec2<u32>(0x0000800au, 0x00000000u),
  vec2<u32>(0x8000000au, 0x80000000u),
  vec2<u32>(0x80008081u, 0x80000000u),
  vec2<u32>(0x00008080u, 0x80000000u),
  vec2<u32>(0x80000001u, 0x00000000u),
  vec2<u32>(0x80008008u, 0x80000000u),
);

// Rho rotation offsets: lane (x + 5*y) → rotate by RHO[x + 5*y].
const RHO = array<u32, 25>(
   0u,  1u, 62u, 28u, 27u,
  36u, 44u,  6u, 55u, 20u,
   3u, 10u, 43u, 25u, 39u,
  41u, 45u, 15u, 21u,  8u,
  18u,  2u, 61u, 56u, 14u,
);

fn keccakF(state: ptr<function, array<vec2<u32>, 25>>) {
  for (var r: u32 = 0u; r < 24u; r = r + 1u) {
    // theta
    var C: array<vec2<u32>, 5>;
    for (var x: u32 = 0u; x < 5u; x = x + 1u) {
      C[x] = (*state)[x] ^ (*state)[x + 5u] ^ (*state)[x + 10u] ^ (*state)[x + 15u] ^ (*state)[x + 20u];
    }
    for (var x: u32 = 0u; x < 5u; x = x + 1u) {
      let d = C[(x + 4u) % 5u] ^ rotl64(C[(x + 1u) % 5u], 1u);
      for (var y: u32 = 0u; y < 5u; y = y + 1u) {
        (*state)[x + 5u * y] = (*state)[x + 5u * y] ^ d;
      }
    }
    // rho + pi
    var B: array<vec2<u32>, 25>;
    for (var y: u32 = 0u; y < 5u; y = y + 1u) {
      for (var x: u32 = 0u; x < 5u; x = x + 1u) {
        let i = x + 5u * y;
        let outIdx = y + 5u * ((2u * x + 3u * y) % 5u);
        B[outIdx] = rotl64((*state)[i], RHO[i]);
      }
    }
    // chi
    for (var y: u32 = 0u; y < 5u; y = y + 1u) {
      for (var x: u32 = 0u; x < 5u; x = x + 1u) {
        let b1 = B[((x + 1u) % 5u) + 5u * y];
        let b2 = B[((x + 2u) % 5u) + 5u * y];
        (*state)[x + 5u * y] = B[x + 5u * y] ^ vec2<u32>((~b1.x) & b2.x, (~b1.y) & b2.y);
      }
    }
    // iota
    (*state)[0] = (*state)[0] ^ RC[r];
  }
}

// Read a 32-bit limb from a flat indexable array<vec4<u32>, 2>.
fn limb8(arr: array<vec4<u32>, 2>, i: u32) -> u32 {
  if (i < 4u) {
    if (i == 0u) { return arr[0].x; }
    if (i == 1u) { return arr[0].y; }
    if (i == 2u) { return arr[0].z; }
    return arr[0].w;
  }
  if (i == 4u) { return arr[1].x; }
  if (i == 5u) { return arr[1].y; }
  if (i == 6u) { return arr[1].z; }
  return arr[1].w;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let perThread = params.perThread;

  // base + threadId * perThread, treated as u64
  let threadOffset = gid.x * perThread;
  var startLo = params.baseNonce.x + threadOffset;
  var startHi = params.baseNonce.y;
  if (startLo < params.baseNonce.x) { startHi = startHi + 1u; }

  for (var t: u32 = 0u; t < perThread; t = t + 1u) {
    var nonceLo = startLo + t;
    var nonceHi = startHi;
    if (nonceLo < startLo) { nonceHi = nonceHi + 1u; }

    // ---- pack input into Keccak rate (lanes 0..16) ----
    var st: array<vec2<u32>, 25>;
    for (var j: u32 = 0u; j < 25u; j = j + 1u) {
      st[j] = vec2<u32>(0u, 0u);
    }

    // challenge: 8 LE u32 limbs → lanes 0..3 (each lane = vec2 of 2 LE u32)
    st[0] = vec2<u32>(limb8(params.challenge, 0u), limb8(params.challenge, 1u));
    st[1] = vec2<u32>(limb8(params.challenge, 2u), limb8(params.challenge, 3u));
    st[2] = vec2<u32>(limb8(params.challenge, 4u), limb8(params.challenge, 5u));
    st[3] = vec2<u32>(limb8(params.challenge, 6u), limb8(params.challenge, 7u));

    // miner: 5 LE u32 limbs → lanes 4, 5, low(6) (limb 4 → lane6.x)
    st[4] = vec2<u32>(limb8(params.miner, 0u), limb8(params.miner, 1u));
    st[5] = vec2<u32>(limb8(params.miner, 2u), limb8(params.miner, 3u));
    st[6] = vec2<u32>(limb8(params.miner, 4u), 0u);

    // nonce: bytes 52..83 of input (32 bytes BE), but only low 8 bytes nonzero.
    // Lanes 7, 8 = 0; lane 9 high = bswap(nonceHi); lane 10 low = bswap(nonceLo).
    st[9]  = vec2<u32>(0u, bswap32(nonceHi));
    st[10] = vec2<u32>(bswap32(nonceLo), 0x00000001u);   // 0x01 padding at byte 84

    // 0x80 padding at byte 135 → lane 16, byte 7 → high u32 high byte
    st[16] = vec2<u32>(0u, 0x80000000u);

    // ---- absorb (single block) + permute ----
    keccakF(&st);

    // ---- digest as 8 BE u32 limbs ----
    var d: array<u32, 8>;
    d[0] = bswap32(st[0].x);
    d[1] = bswap32(st[0].y);
    d[2] = bswap32(st[1].x);
    d[3] = bswap32(st[1].y);
    d[4] = bswap32(st[2].x);
    d[5] = bswap32(st[2].y);
    d[6] = bswap32(st[3].x);
    d[7] = bswap32(st[3].y);

    // ---- compare digest ≤ target as big-endian uint256 ----
    var leq = true;
    var decided = false;
    for (var k: u32 = 0u; k < 8u; k = k + 1u) {
      if (decided) { continue; }
      let tk = limb8(params.target, k);
      if (d[k] < tk) { leq = true;  decided = true; }
      if (d[k] > tk) { leq = false; decided = true; }
    }

    if (leq) {
      let idx = atomicAdd(&hits.count, 1u);
      if (idx < 16u) {
        hits.items[idx].nonceLo = nonceLo;
        hits.items[idx].nonceHi = nonceHi;
        hits.items[idx].digest[0] = vec4<u32>(d[0], d[1], d[2], d[3]);
        hits.items[idx].digest[1] = vec4<u32>(d[4], d[5], d[6], d[7]);
      }
    }
  }
}
`;
