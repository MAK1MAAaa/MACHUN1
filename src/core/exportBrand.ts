const mateLogoUrl = new URL('../assets/chunithm-mate-logo.webp', import.meta.url).href;

const LOGO_ASPECT = 459 / 199;
const LOGO_TIMEOUT_MS = 3_000;

/** A broken brand asset must never prevent a score image from being saved. */
export async function loadMateLogo(): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return null;
  return new Promise(resolve => {
    let logo: HTMLImageElement;
    try { logo = new Image(); } catch { resolve(null); return; }
    let settled = false;
    const finish = (image: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      logo.onload = null;
      logo.onerror = null;
      resolve(image);
    };
    const timeout = window.setTimeout(() => finish(null), LOGO_TIMEOUT_MS);
    logo.decoding = 'async';
    logo.onload = () => finish(logo.naturalWidth > 0 && logo.naturalHeight > 0 ? logo : null);
    logo.onerror = () => finish(null);
    try { logo.src = mateLogoUrl; } catch { finish(null); }
  });
}

/** Returns the reserved logo width; fallback keeps the same layout. */
export function drawMateLogo(context: CanvasRenderingContext2D, logo: HTMLImageElement | null, x: number, y: number, height: number): number {
  const width = height * LOGO_ASPECT;
  context.save();
  let drawn = false;
  if (logo) {
    try { context.drawImage(logo, x, y, width, height); drawn = true; } catch { /* Use the bounded text fallback for a failed decoder. */ }
  }
  if (!drawn) {
    context.textAlign = 'center';
    context.fillStyle = '#c46a65';
    context.font = `900 ${Math.round(height * 0.22)}px Inter, sans-serif`;
    context.fillText('CHUNITHM', x + width / 2, y + height * 0.38);
    context.font = `900 ${Math.round(height * 0.43)}px Inter, sans-serif`;
    context.fillText('MATE', x + width / 2, y + height * 0.83);
  }
  context.restore();
  return width;
}
