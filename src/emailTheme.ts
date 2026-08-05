/**
 * Shared dark-mode email theme (BondBack / Zion) with peach accents.
 * Inline styles only — email-client safe.
 */

export const EMAIL_THEME = {
  bg: '#0b0f14',
  bgElevated: '#121820',
  bgCard: '#161d27',
  bgInset: '#0e141c',
  border: '#273142',
  borderPeach: 'rgba(242,174,102,0.38)',
  text: '#e8eef5',
  textMuted: '#9aa8bc',
  textDim: '#6f7f96',
  peach: '#f2ae66',
  peachBright: '#ffd19c',
  peachSoft: 'rgba(242,174,102,0.14)',
  green: '#3dffb5',
  red: '#f87171',
  white: '#ffffff',
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif",
} as const;

export function escHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function emailStatTile(opts: {
  label: string;
  value: string;
  accent?: 'peach' | 'green' | 'red' | 'default';
}): string {
  const t = EMAIL_THEME;
  const color =
    opts.accent === 'peach'
      ? t.peach
      : opts.accent === 'green'
        ? t.green
        : opts.accent === 'red'
          ? t.red
          : t.white;
  return `<div style="background:${t.bgInset};border:1px solid ${t.border};border-radius:12px;padding:14px;box-sizing:border-box;">
  <div style="font-size:12px;color:${t.textMuted};">${escHtml(opts.label)}</div>
  <div style="font-size:20px;font-weight:700;color:${color};margin-top:4px;">${escHtml(opts.value)}</div>
</div>`;
}

export function emailKvRow(label: string, value: string): string {
  const t = EMAIL_THEME;
  return `<tr>
  <td style="padding:8px 0;font-size:13px;color:${t.textMuted};vertical-align:top;width:38%;">${escHtml(label)}</td>
  <td style="padding:8px 0;font-size:13px;color:${t.text};font-weight:600;vertical-align:top;">${escHtml(value)}</td>
</tr>`;
}

export function emailKvTable(rows: Array<[string, string]>): string {
  const t = EMAIL_THEME;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${t.bgCard};border:1px solid ${t.border};border-radius:16px;padding:4px 18px;">
  <tr><td style="padding:10px 18px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${rows.map(([k, v]) => emailKvRow(k, v)).join('')}
    </table>
  </td></tr>
</table>`;
}

export function emailCard(opts: {
  title?: string;
  bodyHtml: string;
}): string {
  const t = EMAIL_THEME;
  const title = opts.title
    ? `<div style="font-size:13px;color:${t.peach};letter-spacing:0.04em;text-transform:uppercase;margin-bottom:12px;font-weight:700;">${escHtml(opts.title)}</div>`
    : '';
  return `<div style="background:${t.bgCard};border:1px solid ${t.border};border-radius:16px;padding:18px 20px;margin-bottom:16px;">
  ${title}${opts.bodyHtml}
</div>`;
}

export function emailCta(opts: { href: string; label: string }): string {
  const t = EMAIL_THEME;
  return `<div style="text-align:center;margin:18px 0 8px;">
  <a href="${escHtml(opts.href)}" style="display:inline-block;background:${t.peach};color:#2b1807;text-decoration:none;font-weight:800;font-size:14px;padding:12px 22px;border-radius:10px;">${escHtml(opts.label)}</a>
</div>`;
}

export function emailParagraphsFromText(text: string): string {
  const t = EMAIL_THEME;
  return String(text || '')
    .split(/\n{2,}/)
    .map((block) => {
      const inner = escHtml(block).replace(/\n/g, '<br/>');
      return `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:${t.text};">${inner}</p>`;
    })
    .join('');
}

export function emailListItems(items: string[]): string {
  const t = EMAIL_THEME;
  if (!items.length) return '';
  return `<ul style="margin:0;padding-left:18px;color:${t.text};font-size:14px;line-height:1.55;">
  ${items
    .map(
      (i) =>
        `<li style="margin-bottom:6px;color:${t.text};">${escHtml(i)}</li>`
    )
    .join('')}
</ul>`;
}

/**
 * Full dark email document with peach hero accents.
 */
export function renderDarkEmail(opts: {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  bodyHtml: string;
  footerHtml?: string;
}): string {
  const t = EMAIL_THEME;
  const eyebrow = opts.eyebrow
    ? `<div style="font-size:12px;letter-spacing:1.2px;color:${t.peach};text-transform:uppercase;margin-bottom:8px;font-weight:700;">${escHtml(opts.eyebrow)}</div>`
    : '';
  const subtitle = opts.subtitle
    ? `<div style="font-size:13px;color:${t.textMuted};margin-top:8px;">${escHtml(opts.subtitle)}</div>`
    : '';
  const footer =
    opts.footerHtml ||
    `<div style="text-align:center;font-size:12px;color:${t.textDim};line-height:1.55;padding:8px 6px 4px;">
  BondBack · ZION<br/>Zeal, Insight, Order, Navigation
</div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="color-scheme" content="dark"/>
  <meta name="supported-color-schemes" content="dark"/>
  <title>${escHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${t.bg};font-family:${t.font};color:${t.text};">
  <div style="max-width:640px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(145deg,#1a1520 0%,${t.bgElevated} 55%,#121820 100%);border:1px solid ${t.borderPeach};border-radius:16px;padding:20px 22px;margin-bottom:16px;">
      ${eyebrow}
      <div style="font-size:22px;font-weight:750;color:${t.white};line-height:1.25;">${escHtml(opts.title)}</div>
      ${subtitle}
      <div style="height:3px;width:56px;background:linear-gradient(90deg,${t.peachBright},${t.peach});border-radius:2px;margin-top:14px;"></div>
    </div>
    ${opts.bodyHtml}
    ${footer}
  </div>
</body>
</html>`;
}
