// The DOM names of the modules the engine worker bundles (src/encode, src/transport)
// that the WebWorker library lacks, for tsconfig.worker.json only (spec/06-web-sdk.md
// 6.1.3). A MediaStreamTrack reaches a dedicated worker transferred (Safari 18+); the
// settings and the rVFC metadata are plain dictionaries there. tsconfig.json and
// tsconfig.build.json exclude this file: the DOM library declares these names itself.

interface MediaStreamTrack extends EventTarget {
  readonly kind: string;
  readonly id: string;
  enabled: boolean;
  readonly readyState: "live" | "ended";
  getSettings(): MediaTrackSettings;
  stop(): void;
}

interface MediaStreamVideoTrack extends MediaStreamTrack {
  readonly kind: "video";
}

interface MediaStream extends EventTarget {
  readonly id: string;
}

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
}

interface MediaTrackSettings {
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

interface VideoFrameCallbackMetadata {
  captureTime?: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
}
