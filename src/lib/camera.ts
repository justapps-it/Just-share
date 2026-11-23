// Camera scanning: frames from the rear camera, QR decoding in a WASM worker.
let worker: Worker | undefined;
let seq = 0;
const waiting = new Map<number, (b: Uint8Array | null) => void>();

function decoder(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/scan.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; bytes: Uint8Array | null }>) => {
      waiting.get(e.data.id)?.(e.data.bytes);
      waiting.delete(e.data.id);
    };
  }
  return worker;
}

export function decodeImage(image: ImageData): Promise<Uint8Array | null> {
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    decoder().postMessage({ id, image }, [image.data.buffer]);
  });
}

/**
 * Starts the camera on `video` and calls `onCode` for each QR read, as fast
 * as the decoder keeps up. Returns a stop function.
 */
export async function scanCamera(video: HTMLVideoElement, onCode: (bytes: Uint8Array) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});
  // Continuous autofocus where supported.
  const track = stream.getVideoTracks()[0];
  track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {});

  let stopped = false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const loop = async () => {
    while (!stopped) {
      if (video.videoWidth) {
        // Center square crop: QR codes are square and smaller images decode faster.
        const side = Math.min(video.videoWidth, video.videoHeight);
        const size = Math.min(side, 1080);
        canvas.width = canvas.height = size;
        ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, size, size);
        const bytes = await decodeImage(ctx.getImageData(0, 0, size, size));
        if (bytes && !stopped) onCode(bytes);
      } else await new Promise((r) => setTimeout(r, 50));
    }
  };
  void loop();
  return () => {
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
}
