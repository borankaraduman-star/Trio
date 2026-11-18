/** Pure helpers around `enumerateDevices` (CONTRACT-V2 §4, the settings dialog). */

export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput'

export interface DeviceInfoLike {
  deviceId: string
  kind: string
  label: string
  groupId?: string
}

export interface DeviceOption {
  /** '' = the system default. */
  id: string
  label: string
}

const FALLBACK_NAMES: Record<DeviceKind, string> = {
  audioinput: 'Mikrofon',
  audiooutput: 'Hoparlör',
  videoinput: 'Kamera',
}

/** Chrome's pseudo-devices; "default" is what '' already means. */
const PSEUDO_IDS = new Set(['default', 'communications'])

/**
 * The options for one select: "system default" first, then each real device.
 * Before a permission grant browsers hide labels (and often ids): a device
 * without a label gets "Mikrofon 2", one without an id cannot be chosen and
 * is left out.
 */
export function deviceOptions(devices: readonly DeviceInfoLike[], kind: DeviceKind): DeviceOption[] {
  const options: DeviceOption[] = [{ id: '', label: 'Sistem varsayılanı' }]
  const seen = new Set<string>()
  let index = 0
  for (const device of devices) {
    if (device.kind !== kind) continue
    if (!device.deviceId || PSEUDO_IDS.has(device.deviceId) || seen.has(device.deviceId)) continue
    seen.add(device.deviceId)
    index += 1
    options.push({ id: device.deviceId, label: device.label.trim() || `${FALLBACK_NAMES[kind]} ${index}` })
  }
  return options
}

/** True when the browser hides device names (no permission yet). */
export function labelsHidden(devices: readonly DeviceInfoLike[], kind: DeviceKind): boolean {
  const ofKind = devices.filter((device) => device.kind === kind)
  return ofKind.length > 0 && ofKind.every((device) => device.label.trim() === '')
}

export function sinkIdSupported(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
}

/**
 * What a stored device choice should become, given the devices visible now:
 * the same id when it is still there; the device with the stored NAME when
 * the id is not (ids that change between page loads); '' when the device can
 * be seen to be gone; unchanged when nothing can be concluded (no ids or names
 * visible yet). Returns null when the choice stands as it is.
 */
export function repairDeviceChoice(
  devices: readonly DeviceInfoLike[],
  kind: DeviceKind,
  id: string,
  label: string,
): { id: string; label: string } | null {
  if (!id) return null
  const ofKind = devices.filter((device) => device.kind === kind && device.deviceId !== '')
  if (ofKind.length === 0 || ofKind.some((device) => device.deviceId === id)) return null
  if (label) {
    if (ofKind.every((device) => device.label.trim() === '')) return null
    const named = new Set(
      ofKind.filter((device) => device.label === label && !PSEUDO_IDS.has(device.deviceId)).map((device) => device.deviceId),
    )
    if (named.size === 1) return { id: [...named][0], label }
  }
  return { id: '', label: '' }
}

