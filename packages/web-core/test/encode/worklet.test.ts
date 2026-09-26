import { describe, expect, it } from "vitest";
import { WORKLET_PROCESSOR } from "../../src/encode/index.js";

// spec/06-web-sdk.md 6.2.4: static/capture.worklet.js in an AudioWorkletGlobalScope made
// with node:vm. @types/node is not a dependency of this package, so the two Node built-ins
// the test uses are typed here.
type Vm = { runInNewContext(code: string, context: object): unknown };
type Fs = { readFileSync(path: URL, encoding: "utf8"): string };
const builtin = <T>(name: string): Promise<T> =>
  import(/* @vite-ignore */ name) as Promise<T>;

type Posted = { data: { t: number; d: Float32Array }; transfer: unknown[] };
type Processor = {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: object,
  ): boolean;
};

async function worklet(sampleRate: number, currentFrame = 0) {
  const vm = await builtin<Vm>("node:vm");
  const fs = await builtin<Fs>("node:fs");
  const code = fs.readFileSync(
    new URL("../../static/capture.worklet.js", import.meta.url),
    "utf8",
  );
  const posted: Posted[] = [];
  const registered = new Map<string, new () => Processor>();
  const scope = {
    sampleRate,
    currentFrame,
    AudioWorkletProcessor: class {
      port = {
        postMessage: (data: Posted["data"], transfer: unknown[]) =>
          posted.push({ data, transfer }),
      };
    },
    registerProcessor: (name: string, ctor: new () => Processor) =>
      registered.set(name, ctor),
  };
  vm.runInNewContext(code, scope);
  const Ctor = registered.get(WORKLET_PROCESSOR);
  if (!Ctor) throw new Error(`${WORKLET_PROCESSOR} was not registered`);
  const node = new Ctor();
  let next = 0;
  // Render quanta of 128 frames: channel 0 a ramp of frame numbers, channel 1 constant.
  const render = (quanta: number, channels = 2) => {
    for (let q = 0; q < quanta; q++) {
      const input = Array.from({ length: channels }, (_, c) =>
        Float32Array.from({ length: 128 }, (_, i) => (c ? -1 : next + i)),
      );
      expect(node.process([input], [], {})).toBe(true);
      next += 128;
      scope.currentFrame += 128;
    }
  };
  return { posted, render, scope };
}

describe("static/capture.worklet.js", () => {
  it.each([
    [48000, 960],
    [44100, 882],
    [16000, 320],
  ])(
    "posts 20 ms Float32 blocks of channel 0 at %i Hz, each with its first sample's context time",
    async (rate, size) => {
      const { posted, render } = await worklet(rate, 25600);
      render(Math.ceil((size * 3) / 128));
      expect(posted).toHaveLength(3);
      posted.forEach(({ data, transfer }, k) => {
        expect(Object.prototype.toString.call(data.d)).toBe(
          "[object Float32Array]",
        );
        expect(data.d.length / rate).toBeCloseTo(0.02, 9);
        expect(Array.from(data.d)).toEqual(
          Array.from({ length: size }, (_, i) => k * size + i),
        );
        expect(data.t).toBeCloseTo((25600 + k * size) / rate, 9);
        expect(transfer).toEqual([data.d.buffer]);
      });
    },
  );

  it("posts nothing while its input has no channel", async () => {
    const { posted, render } = await worklet(48000);
    render(20, 0);
    expect(posted).toEqual([]);
  });
});
