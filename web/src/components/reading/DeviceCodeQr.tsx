import { deviceLinkUrl } from '../../lib/deviceLink'
import { QrCode } from './QrCode'

/** V7-READING §7: the device code as a QR of `<origin>/#cihaz=<code>`, for a phone's camera. */
export function DeviceCodeQr({ code }: { code: string }) {
  const url = deviceLinkUrl(window.location.origin, code)
  return (
    <div className="device-code-qr" data-testid="link-code-qr" data-url={url}>
      <QrCode text={url} label="Cihaz kodunun karekodu" />
      <p className="link-code-help">
        Ya da telefonunun kamerasıyla bu karekodu okut: Trio açılır, kod kendiliğinden yazılır.
      </p>
    </div>
  )
}
