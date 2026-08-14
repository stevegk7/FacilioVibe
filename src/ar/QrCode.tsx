// Lifted from asset-lens src/components/QrCode.tsx.
// Offline QR renderer (no CDN, CSP-safe): qrcode-generator builds the module
// matrix, we draw it as a single SVG path so it stays crisp at print size.
import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export function QrCode({ value, size = 176, quiet = 2 }: { value: string; size?: number; quiet?: number }) {
  const { path, dim } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    return { path: d, dim: count + quiet * 2 };
  }, [value, quiet]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      style={{ background: '#fff', borderRadius: 6, display: 'block' }}
      role="img"
      aria-label={`QR code for ${value}`}
    >
      <rect width={dim} height={dim} fill="#fff" />
      <path d={path} fill="#0B1220" />
    </svg>
  );
}

/** Printable label: QR + human-readable caption, one per A4-ish card. */
export function printQrLabel(opts: { code: string; title: string; subtitle?: string; svg: string }) {
  const w = window.open('', '_blank', 'width=420,height=560');
  if (!w) return;
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${opts.title}</title>
<style>
  body { font-family: Roboto, system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  .card { width: 320px; padding: 24px; border: 1px solid #D8E3F1; border-radius: 12px; text-align: center; }
  .card svg { margin: 0 auto; }
  h1 { font-size: 18px; margin: 16px 0 4px; color: #283648; }
  p { margin: 0; font-size: 12px; color: #607796; }
  code { display: block; margin-top: 10px; font-size: 11px; color: #7B91B0; word-break: break-all; }
  @media print { .card { border: none; } }
</style>
<div class="card">${opts.svg}<h1>${opts.title}</h1><p>${opts.subtitle ?? ''}</p><code>${opts.code}</code></div>
<script>window.onload = () => setTimeout(() => window.print(), 300)</script>`);
  w.document.close();
}
