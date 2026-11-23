/// <reference lib="webworker" />
// QR decoding with ZXing compiled to WebAssembly, off the main thread.
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

declare const self: DedicatedWorkerGlobalScope;

prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
  fireImmediately: true,
});

self.onmessage = async (e: MessageEvent<{ id: number; image: ImageData }>) => {
  const { id, image } = e.data;
  try {
    const results = await readBarcodes(image, { formats: ['QRCode'], tryHarder: true, tryInvert: false, maxNumberOfSymbols: 1 });
    const bytes = results.find((r) => r.isValid)?.bytes;
    self.postMessage({ id, bytes: bytes ?? null }, bytes ? [bytes.buffer] : []);
  } catch {
    self.postMessage({ id, bytes: null });
  }
};
