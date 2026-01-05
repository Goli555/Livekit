class GeminiMicProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    const buffer = new Float32Array(channel.length);
    buffer.set(channel);
    this.port.postMessage(
      { type: "audio", sampleRate, buffer },
      [buffer.buffer],
    );
    return true;
  }
}

registerProcessor("gemini-mic-processor", GeminiMicProcessor);
