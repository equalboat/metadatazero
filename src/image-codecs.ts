import type { EncodeRequest } from './image-export';

export async function encodeImage({ pixels, format, quality, effort, lossless }: EncodeRequest): Promise<ArrayBuffer> {
  if (format === 'avif') {
    const { default: encode } = await import('@jsquash/avif/encode.js');
    return encode(pixels, { quality: lossless ? 100 : quality, speed: 10 - effort, lossless });
  }
  const { default: encode } = await import('@jsquash/webp/encode.js');
  return encode(pixels, { quality: lossless ? 100 : quality, method: effort, lossless: Number(lossless) });
}
