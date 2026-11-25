import { encodeImage } from './image-codecs';
import type { EncodeRequest, EncodeResult } from './image-export';

self.onmessage = async ({ data }: MessageEvent<EncodeRequest>) => {
  try {
    const bytes = await encodeImage(data);
    self.postMessage({ bytes } satisfies EncodeResult, { transfer: [bytes] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies EncodeResult);
  }
};
