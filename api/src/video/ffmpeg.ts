import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

const FFMPEG = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string);
const ASSETS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../assets');
export const FONT_BOLD = join(ASSETS, 'fonts/Roboto-Bold.ttf');
export const FONT_MEDIUM = join(ASSETS, 'fonts/Roboto-Medium.ttf');

export function runFfmpeg(args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) ok();
      else fail(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`));
    });
    p.on('error', fail);
  });
}

/** Runs `fn` with a scratch directory that is always removed afterwards. */
export async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pda-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Crops a fractional rectangle (0..1) out of an image; returns PNG bytes. */
export async function cropImage(
  image: Buffer,
  r: { left: number; top: number; right: number; bottom: number },
): Promise<Buffer> {
  return withTemp(async (dir) => {
    const src = join(dir, 'src');
    const out = join(dir, 'out.png');
    await writeFile(src, image);
    const w = (r.right - r.left).toFixed(4);
    const h = (r.bottom - r.top).toFixed(4);
    await runFfmpeg(['-i', src, '-vf', `crop=iw*${w}:ih*${h}:iw*${r.left.toFixed(4)}:ih*${r.top.toFixed(4)}`, '-frames:v', '1', out]);
    return readFile(out);
  });
}
