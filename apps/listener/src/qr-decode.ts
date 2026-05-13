import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const jsQR = require('jsqr') as typeof import('jsqr').default;

const IMAGE_QR_MAX_EDGE = 1600;
const MIN_SHORT_EDGE_UPSCALE = 720;
const UPSCALE_TARGET_SHORT_EDGE = 1100;
const TOTAL_DECODE_BUDGET_MS = 12_000;
const PER_ATTEMPT_TIMEOUT_MS = 2500;

type InversionAttempts = 'dontInvert' | 'onlyInvert' | 'attemptBoth';

function jsQrDecode(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  inversionAttempts: InversionAttempts,
): ReturnType<typeof jsQR> {
  return jsQR(data, width, height, { inversionAttempts });
}

async function toRgbaRaw(img: sharp.Sharp): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

type ResizeMode =
  | { kind: 'maxInside'; edge: number }
  | { kind: 'upscaleShort'; targetShort: number };

type AttemptSpec = {
  resize: ResizeMode | null;
  extraRotate: number;
  normalize: boolean;
  sharpen: boolean;
  inversionAttempts: InversionAttempts;
};

function specsForImage(shortEdge: number): AttemptSpec[] {
  const rotations = [0, 90, 180, 270] as const;
  const preprocess: Array<{ normalize: boolean; sharpen: boolean }> = [
    { normalize: false, sharpen: false },
    { normalize: true, sharpen: true },
  ];

  const resizeVariants: (ResizeMode | null)[] = [{ kind: 'maxInside', edge: IMAGE_QR_MAX_EDGE }];
  if (shortEdge > 0 && shortEdge < MIN_SHORT_EDGE_UPSCALE) {
    resizeVariants.push({ kind: 'upscaleShort', targetShort: UPSCALE_TARGET_SHORT_EDGE });
  }

  const out: AttemptSpec[] = [];
  for (const resize of resizeVariants) {
    for (const extraRotate of rotations) {
      for (const { normalize, sharpen } of preprocess) {
        out.push({
          resize,
          extraRotate,
          normalize,
          sharpen,
          inversionAttempts: 'attemptBoth',
        });
      }
    }
  }
  return out;
}

async function runOneAttempt(imageBuffer: Buffer, spec: AttemptSpec): Promise<string | null> {
  const meta = await sharp(imageBuffer, { failOn: 'none' }).rotate().metadata();
  const w0 = meta.width ?? 0;
  const h0 = meta.height ?? 0;

  let p = sharp(imageBuffer, { failOn: 'none' }).rotate();

  if (spec.resize) {
    if (spec.resize.kind === 'maxInside') {
      const edge = spec.resize.edge;
      if (w0 > edge || h0 > edge) {
        p = p.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
      }
    } else {
      const short = Math.min(w0, h0);
      if (short > 0 && short < MIN_SHORT_EDGE_UPSCALE) {
        p = p.resize({
          width: spec.resize.targetShort,
          height: spec.resize.targetShort,
          fit: 'inside',
          withoutEnlargement: false,
        });
      }
    }
  }

  if (spec.normalize) {
    p = p.normalize();
  }
  if (spec.sharpen) {
    p = p.sharpen();
  }
  if (spec.extraRotate !== 0) {
    p = p.rotate(spec.extraRotate);
  }

  const { data, width, height } = await toRgbaRaw(p);
  if (width < 2 || height < 2) return null;

  const qr = jsQrDecode(data, width, height, spec.inversionAttempts);
  const value = qr?.data?.trim();
  return value ? value : null;
}

/**
 * Multi-pass QR decode for camera JPEGs: EXIF rotation, optional upscale, extra rotations,
 * normalize/sharpen, jsQR inversionAttempts, bounded total time.
 */
export async function decodeQrFromImageBuffer(imageBuffer: Buffer): Promise<string | null> {
  const deadline = Date.now() + TOTAL_DECODE_BUDGET_MS;

  const meta = await sharp(imageBuffer, { failOn: 'none' }).rotate().metadata();
  const w0 = meta.width ?? 0;
  const h0 = meta.height ?? 0;
  const short = Math.min(w0, h0);
  const attempts = specsForImage(short);

  for (const spec of attempts) {
    if (Date.now() >= deadline) return null;
    const remaining = Math.max(400, deadline - Date.now());
    const attemptMs = Math.min(PER_ATTEMPT_TIMEOUT_MS, remaining);
    try {
      const result = await withTimeout(runOneAttempt(imageBuffer, spec), attemptMs);
      if (result === 'timeout') continue;
      if (result) return result;
    } catch {
      /* try next */
    }
  }

  return null;
}
