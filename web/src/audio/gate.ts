/**
 * The input gate's AudioWorklet (CONTRACT-V6-VOICE §4). The processor module
 * is built at runtime from `createGate`'s own source (gateCore.ts) and loaded
 * from a blob: URL, which the app's CSP allows (`script-src 'self' blob:`,
 * as for RNNoise): the DSP the unit tests check is the DSP that runs. If the
 * module or the node cannot be made, the caller sends without a gate.
 */
import { createGate, GATE_HOLD_MS, GATE_LOOKAHEAD_MS } from './gateCore'

export const GATE_PROCESSOR = 'trio-gate'

export function gateModuleSource(): string {
  return `
const createGate = (${createGate.toString()});
class TrioGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.gate = createGate(sampleRate, o.threshold, o.holdMs, o.lookaheadMs);
    this.open = false;
    this.silence = new Float32Array(128);
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.threshold === 'number') this.gate.setThreshold(event.data.threshold);
    };
  }
  process(inputs, outputs) {
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    let input = inputs[0] && inputs[0][0];
    if (!input) {
      if (this.silence.length !== output.length) this.silence = new Float32Array(output.length);
      input = this.silence;
    }
    this.gate.process(input, output);
    const open = this.gate.isOpen();
    if (open !== this.open) {
      this.open = open;
      this.port.postMessage({ open });
    }
    return true;
  }
}
registerProcessor('${GATE_PROCESSOR}', TrioGateProcessor);
`
}

const modules = new WeakMap<BaseAudioContext, Promise<void>>()

function loadModule(context: AudioContext): Promise<void> {
  let loading = modules.get(context)
  if (!loading) {
    const url = URL.createObjectURL(new Blob([gateModuleSource()], { type: 'text/javascript' }))
    loading = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    modules.set(context, loading)
    loading.catch(() => modules.delete(context))
  }
  return loading
}

/** A ready gate node (mono in, mono out). Throws when it cannot be made. */
export async function createGateNode(context: AudioContext, thresholdLinear: number): Promise<AudioWorkletNode> {
  if (!context.audioWorklet) throw new Error('AudioWorklet is not available')
  await loadModule(context)
  return new AudioWorkletNode(context, GATE_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { threshold: thresholdLinear, holdMs: GATE_HOLD_MS, lookaheadMs: GATE_LOOKAHEAD_MS },
  })
}
