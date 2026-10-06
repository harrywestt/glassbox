// Records the microphone on the audio thread, so nothing is lost while the app is busy (the main
// thread drawing a streaming reply used to drop audio and garble transcripts). Samples are batched
// into ~85 ms chunks and posted to the page, which queues them however late it gets to them.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(4096)
    this.at = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.at++] = ch[i]
        if (this.at === this.buf.length) {
          this.port.postMessage(this.buf)
          this.buf = new Float32Array(4096)
          this.at = 0
        }
      }
    }
    return true
  }
}

registerProcessor('glassbox-capture', Capture)
