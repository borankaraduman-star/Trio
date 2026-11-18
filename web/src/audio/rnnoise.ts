/**
 * RNNoise through @sapphi-red/web-noise-suppressor. Imported lazily by the
 * pipeline, so the worklet and wasm are only fetched when noise suppression
 * is used. Every file is a local asset of the build (`?url`): nothing comes
 * from a CDN at runtime.
 */
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import simdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

/** RNNoise processes 480-sample frames of 48 kHz audio; the node assumes that rate. */
export const RNNOISE_SAMPLE_RATE = 48000

let binary: Promise<ArrayBuffer> | null = null
const modules = new WeakMap<BaseAudioContext, Promise<void>>()

function loadBinary(): Promise<ArrayBuffer> {
  if (!binary) {
    binary = (async () => {
      const bytes = await loadRnnoise({ url: wasmUrl, simdUrl: simdWasmUrl })
      // The worklet compiles it again with no way to report a failure (it would
      // just output silence), so prove here that it compiles at all.
      await WebAssembly.compile(bytes)
      return bytes
    })()
    // A failed load may succeed later (network): do not cache the failure.
    binary.catch(() => {
      binary = null
    })
  }
  return binary
}

function loadModule(context: AudioContext): Promise<void> {
  let loading = modules.get(context)
  if (!loading) {
    loading = context.audioWorklet.addModule(workletUrl)
    modules.set(context, loading)
    loading.catch(() => modules.delete(context))
  }
  return loading
}

/** A ready RNNoise node for this context. Throws when it cannot be made. */
export async function createRnnoiseNode(context: AudioContext): Promise<AudioWorkletNode> {
  if (context.sampleRate !== RNNOISE_SAMPLE_RATE) {
    throw new Error(`RNNoise needs ${RNNOISE_SAMPLE_RATE} Hz, the context runs at ${context.sampleRate} Hz`)
  }
  if (!context.audioWorklet) throw new Error('AudioWorklet is not available')
  const [wasmBinary] = await Promise.all([loadBinary(), loadModule(context)])
  // The processor keeps its own copy; hand it one so the cached bytes survive.
  return new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: wasmBinary.slice(0) })
}

export const RNNOISE_ASSETS = { workletUrl, wasmUrl, simdWasmUrl }
