import kleur from 'kleur';

export const c = kleur;

export const log = {
  step:    (s) => console.log(`\n${kleur.cyan().bold('▸')} ${kleur.bold(s)}`),
  ok:      (s) => console.log(`  ${kleur.green('✓')} ${s}`),
  info:    (s) => console.log(`  ${kleur.dim(s)}`),
  warn:    (s) => console.log(`  ${kleur.yellow('⚠')} ${s}`),
  err:     (s) => console.error(`  ${kleur.red('✗')} ${s}`),
  banner:  (s) => console.log(`\n${kleur.bold(s)}`),
  table:   (rows) => {
    const widths = {};
    for (const r of rows) for (const k in r) widths[k] = Math.max(widths[k] || k.length, String(r[k]).length);
    const fmt = (r) => Object.entries(widths).map(([k, w]) => String(r[k] ?? '').padEnd(w)).join('  ');
    console.log('  ' + kleur.dim(fmt(Object.fromEntries(Object.keys(widths).map(k => [k, k])))));
    console.log('  ' + kleur.dim('─'.repeat(Object.values(widths).reduce((a,b) => a+b+2, -2))));
    for (const r of rows) console.log('  ' + fmt(r));
  },
};
