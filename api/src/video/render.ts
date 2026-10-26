import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { FONT_BOLD, FONT_MEDIUM, runFfmpeg, withTemp } from './ffmpeg.js';

export type Template = 'product' | 'collection' | 'sale' | 'new';

export interface Slide {
  /** Image bytes shown large (the staged scene when available, else the original photo). */
  image: Buffer;
  /** Image bytes used for the blurred background (usually the original photo). */
  background: Buffer;
  title: string;
  priceLine: string | null;
  /** Previous price for the "sale" template. Only shown when it is real. */
  oldPriceLine: string | null;
  stockLine: string | null;
}

export interface RenderInput {
  template: Template;
  shopName: string;
  headline: string;
  cta: string;
  slides: Slide[];
}

const W = 1080;
const H = 1920;
const FPS = 30;
const ACCENT_CSS = '#6938EF';

const TAG: Record<Template, string> = {
  product: '',
  collection: '',
  sale: 'AKSIYA',
  new: 'YANGI KELDI',
};

/** Seconds per slide: one product gets a longer, slower shot. */
export function slideSeconds(count: number): number {
  return count <= 1 ? 9 : count <= 3 ? 4 : 3;
}

/**
 * Renders a 1080×1920 H.264/AAC Reel. Each slide is rendered separately and the
 * parts are joined with the concat demuxer, which keeps the filter graphs small.
 */
export async function renderPromo(input: RenderInput, outFile: string): Promise<void> {
  if (input.slides.length === 0) throw new Error('No slides to render');
  const secs = slideSeconds(input.slides.length);
  await withTemp(async (dir) => {
    const parts: string[] = [];
    for (const [i, slide] of input.slides.entries()) {
      const part = join(dir, `part${i}.mp4`);
      await renderSlide(dir, i, slide, input, secs, part);
      parts.push(part);
    }
    const list = join(dir, 'list.txt');
    await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
    const joined = join(dir, 'joined.mp4');
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
    // Silent AAC track: Reels expect audio, and a fixed track keeps every player happy.
    await runFfmpeg([
      '-i', joined,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-shortest', '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', join(dir, 'final.mp4'),
    ]);
    await copyFile(join(dir, 'final.mp4'), outFile);
  });
}

async function renderSlide(dir: string, i: number, slide: Slide, input: RenderInput, secs: number, out: string): Promise<void> {
  const fg = join(dir, `fg${i}`);
  const bg = join(dir, `bg${i}`);
  const ov = join(dir, `ov${i}.png`);
  await writeFile(fg, slide.image);
  await writeFile(bg, slide.background);
  await writeFile(ov, drawOverlay(slide, input));

  const frames = secs * FPS;
  const { width: fw, height: fh } = await fitBox(slide.image, 900, 900);
  const top = 200 + Math.round((900 - fh) / 2);
  const filters = [
    // Background: the photo, cropped to fill, blurred and darkened.
    `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:2,eq=brightness=-0.18:saturation=1.1,setsar=1[bg]`,
    // Foreground keeps its own aspect ratio inside a 900×900 area, with a slow push-in.
    `[0:v]scale=${fw}:${fh},setsar=1,` +
      `zoompan=z='min(zoom+0.0007,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${fw}x${fh}:fps=${FPS}[fg]`,
    `[bg][fg]overlay=(W-w)/2:${top}:shortest=1[base]`,
    // Text layer fades in after the product appears.
    `[2:v]format=rgba,fade=t=in:st=0.3:d=0.5:alpha=1[ov]`,
    `[base][ov]overlay=0:0:shortest=1,format=yuv420p[out]`,
  ];

  await runFfmpeg([
    '-loop', '1', '-t', String(secs), '-i', fg,
    '-loop', '1', '-t', String(secs), '-i', bg,
    '-loop', '1', '-t', String(secs), '-i', ov,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-r', String(FPS), '-t', String(secs),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    out,
  ]);
}

/** Largest even-sized box with the image's aspect ratio that fits in maxW×maxH. */
export async function fitBox(image: Buffer, maxW: number, maxH: number): Promise<{ width: number; height: number }> {
  const img = await loadImage(image);
  const scale = Math.min(maxW / img.width, maxH / img.height);
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  return { width: even(img.width * scale), height: even(img.height * scale) };
}

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(FONT_BOLD, 'PdBold');
  GlobalFonts.registerFromPath(FONT_MEDIUM, 'PdMedium');
  fontsReady = true;
}

/** Transparent 1080×1920 PNG with every text element of one slide. */
export function drawOverlay(slide: Slide, input: RenderInput): Buffer {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // Shop name on top, on a soft pill.
  ctx.font = '44px PdMedium';
  const shopW = Math.min(W - 120, ctx.measureText(input.shopName).width + 64);
  pill(ctx, (W - shopW) / 2, 96, shopW, 76, 38, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = '#ffffff';
  ctx.fillText(input.shopName, W / 2, 111, W - 160);

  let y = 1130;
  const tag = TAG[input.template];
  if (tag) {
    ctx.font = '40px PdBold';
    const tw = ctx.measureText(tag).width + 70;
    pill(ctx, (W - tw) / 2, y, tw, 72, 36, ACCENT_CSS);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(tag, W / 2, y + 15);
  }
  y += 100;

  ctx.font = '72px PdBold';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 12;
  for (const line of wrapByWidth(ctx, slide.title, W - 140, 3)) {
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, W / 2, y);
    y += 86;
  }
  ctx.shadowBlur = 0;
  y += 24;

  if (slide.priceLine) {
    ctx.font = '66px PdBold';
    const pw = Math.max(420, ctx.measureText(slide.priceLine).width + 100);
    pill(ctx, (W - pw) / 2, y, pw, 118, 30, ACCENT_CSS);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(slide.priceLine, W / 2, y + 24);
    y += 140;
  }
  if (slide.oldPriceLine) {
    ctx.font = '46px PdMedium';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(slide.oldPriceLine, W / 2, y);
    const ow = ctx.measureText(slide.oldPriceLine).width;
    ctx.fillRect((W - ow) / 2 - 6, y + 25, ow + 12, 4);
    y += 70;
  }
  if (slide.stockLine) {
    ctx.font = '44px PdMedium';
    ctx.fillStyle = '#C4B5FD';
    ctx.fillText(slide.stockLine, W / 2, y);
  }

  // Call to action bar.
  const grad = ctx.createLinearGradient(0, H - 260, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, H - 260, W, 260);
  ctx.font = '48px PdBold';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(input.cta, W / 2, H - 140, W - 100);

  return canvas.toBuffer('image/png');
}

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

function pill(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/** Word wrap by measured width; the last line gets an ellipsis if text remains. */
function wrapByWidth(ctx: Ctx, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = `${kept[maxLines - 1]}…`;
  while (ctx.measureText(last).width > maxWidth && last.length > 2) last = `${last.slice(0, -2)}…`;
  kept[maxLines - 1] = last;
  return kept;
}

/** Greedy word wrap; the last line gets an ellipsis if the text does not fit. */
export function wrap(text: string, width: number, maxLines: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width || !line) {
      line = next.length > width ? next.slice(0, width) : next;
    } else {
      lines.push(line);
      line = word.slice(0, width);
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, width - 1)}…`;
    return kept.join('\n');
  }
  return lines.join('\n');
}

/** "189000" → "189 000 so'm" (Uzbek grouping); other currencies keep their code. */
export function formatPrice(amount: number, currency: string | null): string {
  const grouped = Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const cur = !currency || /^(uzs|so'?m)$/i.test(currency) ? "so'm" : currency.toUpperCase() === 'USD' ? '$' : currency.toUpperCase();
  return cur === '$' ? `$${grouped}` : `${grouped} ${cur}`;
}
