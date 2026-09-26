// Orientation, crop and scale (spec/06-web-sdk.md 6.2.3): frames reach the encoder upright
// and unmirrored, as the centre 3:4 region the encoder scales to the rung size.

/** Orientation metadata camera frames may carry from Chrome 138, missing from lib.dom. */
type Oriented = VideoFrame & {
  readonly rotation?: number;
  readonly flip?: boolean;
};

/**
 * Returns a function that redraws a frame carrying `rotation` or `flip` upright into one
 * reused `OffscreenCanvas` and wraps the canvas as a new frame with the same timestamp;
 * other frames pass through. The caller closes both. `VideoEncoder` would copy the
 * orientation into `decoderConfig` only, which Annex-B does not carry; `drawImage` applies
 * it (rotation is defined as applied on render), so `config.video.rotation` stays 0 and
 * `mirrored` false.
 */
export function upright(): (f: VideoFrame) => VideoFrame {
  let canvas: OffscreenCanvas | undefined;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  return (f) => {
    const { rotation = 0, flip = false } = f as Oriented;
    if (!rotation && !flip) return f;
    const turned = rotation % 180 !== 0;
    const w = turned ? f.displayHeight : f.displayWidth;
    const h = turned ? f.displayWidth : f.displayHeight;
    if (!canvas) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext("2d");
    } else if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx?.drawImage(f, 0, 0, w, h);
    return new VideoFrame(canvas, { timestamp: f.timestamp });
  };
}

/**
 * The centre 3:4 region of a frame as a view (`visibleRect`, even-aligned), without copying;
 * the frame itself when it is 3:4 already. Every rung is an exact 3:4 multiple of 16, so the
 * encoder scales the region to the rung size.
 */
export function crop(f: VideoFrame): VideoFrame {
  const v = f.visibleRect;
  if (!v) return f;
  // 3k x 4k with k even: exactly 3:4, with the even sides 4:2:0 frames need.
  const k = Math.floor(Math.min(v.width / 3, v.height / 4)) & ~1;
  const w = 3 * k;
  const h = 4 * k;
  if (w === v.width && h === v.height) return f;
  const x = v.x + (((v.width - w) >> 1) & ~1);
  const y = v.y + (((v.height - h) >> 1) & ~1);
  return new VideoFrame(f, { visibleRect: { x, y, width: w, height: h } });
}

/**
 * The timestamp, in us, of a frame the `requestVideoFrameCallback` path wraps for
 * `Pipeline.frame`: `captureTime`, else `expectedDisplayTime` (6.2.5).
 */
export function captureTimestamp(m: VideoFrameCallbackMetadata): number {
  return Math.round((m.captureTime ?? m.expectedDisplayTime) * 1000);
}
