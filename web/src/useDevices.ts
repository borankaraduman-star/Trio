import { useCallback, useEffect, useState } from 'react'
import { repairDeviceChoice, type DeviceInfoLike } from './lib/devices'
import { settingsStore } from './settings'

async function enumerate(): Promise<DeviceInfoLike[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.map((device) => ({
      deviceId: device.deviceId,
      kind: device.kind,
      label: device.label,
      groupId: device.groupId,
    }))
  } catch {
    return []
  }
}

/** The current device list, kept fresh on `devicechange`. */
export function useDevices(): {
  devices: DeviceInfoLike[]
  refresh: () => Promise<void>
  /** Asks for microphone (and camera) permission once, so the names show. */
  requestLabels: () => Promise<void>
} {
  const [devices, setDevices] = useState<DeviceInfoLike[]>([])

  const refresh = useCallback(async () => {
    setDevices(await enumerate())
  }, [])

  useEffect(() => {
    void refresh()
    const media = navigator.mediaDevices
    if (!media?.addEventListener) return
    const onChange = () => void refresh()
    media.addEventListener('devicechange', onChange)
    return () => media.removeEventListener('devicechange', onChange)
  }, [refresh])

  const requestLabels = useCallback(async () => {
    const media = navigator.mediaDevices
    if (!media?.getUserMedia) return
    for (const constraints of [{ audio: true }, { video: true }] as MediaStreamConstraints[]) {
      try {
        const stream = await media.getUserMedia(constraints)
        for (const track of stream.getTracks()) track.stop()
      } catch {
        // Refused or absent: that kind keeps its generic names.
      }
    }
    await refresh()
  }, [refresh])

  return { devices, refresh, requestLabels }
}

/**
 * Keeps the stored device choices pointing at real devices: on load, on
 * `devicechange`, and whenever `recheck` changes (the Session passes the voice
 * status: joining is when the browser starts showing names and ids). A device
 * whose id changed is found again by its name; one that is gone falls back to
 * the default (the setting is updated, which the voice engine follows live).
 */
export function useDeviceFallback(recheck: unknown = null): void {
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const devices = await enumerate()
      if (cancelled) return
      const settings = settingsStore.getSnapshot()
      const patch: Parameters<typeof settingsStore.update>[0] = {}
      const mic = repairDeviceChoice(devices, 'audioinput', settings.micDeviceId, settings.micDeviceLabel)
      if (mic) Object.assign(patch, { micDeviceId: mic.id, micDeviceLabel: mic.label })
      const camera = repairDeviceChoice(devices, 'videoinput', settings.cameraDeviceId, settings.cameraDeviceLabel)
      if (camera) Object.assign(patch, { cameraDeviceId: camera.id, cameraDeviceLabel: camera.label })
      const output = repairDeviceChoice(devices, 'audiooutput', settings.outputDeviceId, settings.outputDeviceLabel)
      if (output) Object.assign(patch, { outputDeviceId: output.id, outputDeviceLabel: output.label })
      if (Object.keys(patch).length > 0) settingsStore.update(patch)
    }
    void check()
    const media = navigator.mediaDevices
    if (!media?.addEventListener) {
      return () => {
        cancelled = true
      }
    }
    const onChange = () => void check()
    media.addEventListener('devicechange', onChange)
    return () => {
      cancelled = true
      media.removeEventListener('devicechange', onChange)
    }
  }, [recheck])
}
