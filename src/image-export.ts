export type ExportFormat = 'avif' | 'webp';

export interface Dimensions {
  width: number;
  height: number;
}

export interface Crop extends Dimensions {
  x: number;
  y: number;
}

export interface EncodeRequest {
  pixels: ImageData;
  format: ExportFormat;
  quality: number;
  effort: number;
  lossless: boolean;
}

export type EncodeResult = { bytes: ArrayBuffer } | { error: string };

export const MAX_EDGE = 8192;
export const MAX_PIXELS = 32_000_000;

export function imageMime(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'jpg':
    case 'jpeg':
    case 'jpe': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'avif': return 'image/avif';
    case 'webp': return 'image/webp';
  }
}

export function cropToFill(source: Dimensions, target: Dimensions, horizontal: number, vertical: number): Crop {
  const scale = Math.max(target.width / source.width, target.height / source.height);
  const width = Math.min(source.width, target.width / scale);
  const height = Math.min(source.height, target.height / scale);
  return {
    width,
    height,
    x: (source.width - width) * horizontal / 100,
    y: (source.height - height) * vertical / 100,
  };
}

export function drawExport(source: ImageBitmap, target: Dimensions, crop: Crop): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not prepare the image.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, target.width, target.height);
  // The encoders receive only pixels, so source metadata never enters the export.
  const pixels = context.getImageData(0, 0, target.width, target.height);
  canvas.width = canvas.height = 0;
  return pixels;
}

class EncoderWorkerError extends Error {}

export async function renderExport(makeRequest: () => EncodeRequest, signal: AbortSignal): Promise<ArrayBuffer> {
  let worker: Worker | undefined;
  let onAbort: (() => void) | undefined;
  try {
    try {
      worker = new Worker(new URL('./image-encoder.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      throw new EncoderWorkerError('Could not create the image encoder worker.');
    }
    const encoder = worker;
    const request = makeRequest();
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      encoder.onmessage = ({ data }: MessageEvent<EncodeResult>) => {
        if ('bytes' in data) resolve(data.bytes);
        else reject(new Error(data.error));
      };
      encoder.onerror = (event) => {
        event.preventDefault();
        reject(new EncoderWorkerError('Could not load the image encoder worker.'));
      };
      encoder.postMessage(request, [request.pixels.data.buffer]);
    });
  } catch (error) {
    if (!(error instanceof EncoderWorkerError)) throw error;
    // Some webviews restrict workers loaded from the bundled app's URL scheme.
    const { encodeImage } = await import('./image-codecs');
    signal.throwIfAborted();
    return encodeImage(makeRequest());
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    worker?.terminate();
  }
}
