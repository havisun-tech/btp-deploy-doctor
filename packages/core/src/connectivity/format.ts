import { AppReport, Check, Status } from './diagnose';

function palette(on: boolean) {
  const wrap = (code: number) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { red: wrap(31), yellow: wrap(33), cyan: wrap(36), dim: wrap(2), bold: wrap(1), green: wrap(32) };
}

export function formatConnectivity(r: AppReport, opts: { color?: boolean } = {}): string {
  const c = palette(!!opts.color);
  const icon: Record<Status, string> = { ok: c.green('✔'), info: c.cyan('●'), warning: c.yellow('▲'), error: c.red('✖'), skipped: c.dim('○') };
  const pad = '     ';
  const line = (k: Check, indent: string) => {
    const out = [`${indent}${icon[k.status]} ${k.title}`];
    if (k.detail) out.push(...k.detail.split('\n').map((l) => `${indent}  ${c.dim(l)}`));
    if (k.fix) out.push(`${indent}  ${c.green('Fix:')} ${k.fix}`);
    return out.join('\n');
  };
  const t = r.target;
  const out = [c.bold(`Connectivity Doctor for SAP BTP: ${r.app}`) + (t.org ? c.dim(`  (org ${t.org}, space ${t.space})`) : ''), ''];
  for (const k of r.checks) out.push(line(k, ' '));
  out.push('');
  for (const d of r.destinations) {
    const meta = [d.proxyType, d.authentication, d.level && `${d.level} level`].filter(Boolean).join(' · ');
    out.push(`${icon[d.status]} ${c.bold(d.name)}${meta ? c.dim(`  ${meta}`) : ''}`);
    if (d.url) out.push(`${pad}${c.dim(d.url)}`);
    for (const k of d.checks) out.push(line(k, pad));
    out.push('');
  }
  const n = (s: Status) => r.destinations.filter((d) => d.status === s).length;
  out.push(`${r.destinations.length} destination${r.destinations.length === 1 ? '' : 's'}: ${n('error')} with errors, ${n('warning')} with warnings${n('skipped') ? `, ${n('skipped')} not fully tested` : ''}`);
  return out.join('\n');
}
