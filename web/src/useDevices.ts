import { useCallback, useEffect, useState } from 'react'
import { deviceMissing, type DeviceInfoLike } from './lib/devices'
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
 * On `devicechange`, a chosen device that has disappeared falls back to the
 * default one (the setting is reset, which the voice engine follows live).
 */
export function useDeviceFallback(): void {
  useEffect(() => {
    const media = navigator.mediaDevices
    if (!media?.addEventListener) return
    const check = async () => {
      const devices = await enumerate()
      const settings = settingsStore.getSnapshot()
      const patch: Parameters<typeof settingsStore.update>[0] = {}
      if (deviceMissing(devices, 'audioinput', settings.micDeviceId)) patch.micDeviceId = ''
      if (deviceMissing(devices, 'videoinput', settings.cameraDeviceId)) patch.cameraDeviceId = ''
      if (deviceMissing(devices, 'audiooutput', settings.outputDeviceId)) patch.outputDeviceId = ''
      if (Object.keys(patch).length > 0) settingsStore.update(patch)
    }
    const onChange = () => void check()
    media.addEventListener('devicechange', onChange)
    return () => media.removeEventListener('devicechange', onChange)
  }, [])
}
