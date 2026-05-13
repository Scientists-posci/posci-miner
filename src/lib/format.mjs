/** Format hashes-per-second to a human string. */
export function formatHashrate(hps) {
  if (!Number.isFinite(hps) || hps <= 0) return '0 H/s';
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let i = 0;
  while (hps >= 1000 && i < units.length - 1) { hps /= 1000; i++; }
  return `${hps.toFixed(hps < 10 ? 2 : hps < 100 ? 1 : 0)} ${units[i]}`;
}

/** Format wei BigInt as POSCI (18 decimals) human string. */
export function formatPosci(wei, fractionDigits = 4) {
  if (typeof wei !== 'bigint') wei = BigInt(wei ?? 0);
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const base = 10n ** 18n;
  const whole = v / base;
  const frac = v - whole * base;
  const fracStr = frac.toString().padStart(18, '0').slice(0, fractionDigits).replace(/0+$/, '');
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = fracStr ? `${wholeStr}.${fracStr}` : wholeStr;
  return neg ? `-${out}` : out;
}

/** "0x1234…cdef" — short address. */
export function shortAddr(a, chars = 6) {
  if (!a) return '';
  if (a.length < 2 + chars * 2) return a;
  return `${a.slice(0, 2 + chars)}…${a.slice(-chars)}`;
}

/** "3m 12s" / "1h 5m" / "2d 4h" relative duration. */
export function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ${seconds%60}s`;
  if (seconds < 86400) return `${Math.floor(seconds/3600)}h ${Math.floor((seconds%3600)/60)}m`;
  return `${Math.floor(seconds/86400)}d ${Math.floor((seconds%86400)/3600)}h`;
}
