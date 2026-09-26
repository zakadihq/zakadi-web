/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */
// The webcodecs-worklet audio path (spec/06-web-sdk.md 6.2.4): posts the first input channel
// in 20 ms Float32 blocks, each with the context time of its first sample, for the engine to
// build f32-planar AudioData and map to its clock (6.2.5).
class ZakadiCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 50);
    this.block = new Float32Array(this.size);
    this.filled = 0;
    this.time = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      if (this.filled === 0) this.time = (currentFrame + i) / sampleRate;
      this.block[this.filled++] = channel[i];
      if (this.filled === this.size) {
        this.port.postMessage({ t: this.time, d: this.block }, [
          this.block.buffer,
        ]);
        this.block = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("zakadi-capture", ZakadiCapture);
