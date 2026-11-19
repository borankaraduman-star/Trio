import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/** The QR's modules for `text` (error correction M, the smallest version that fits). */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const count = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let row = 0; row < count; row += 1) {
    const line: boolean[] = []
    for (let col = 0; col < count; col += 1) line.push(qr.isDark(row, col))
    rows.push(line)
  }
  return rows
}

/**
 * CONTRACT-V7-READING §7: a QR drawn locally as an SVG (no image from anywhere,
 * no network). Dark modules on white with the four-module quiet zone the
 * standard asks for, whatever the theme: phone cameras read dark-on-light.
 */
export function QrCode({ text, size = 176, label }: { text: string; size?: number; label: string }) {
  const modules = useMemo(() => qrModules(text), [text])
  const count = modules.length
  const quiet = 4
  const total = count + quiet * 2
  const path = useMemo(() => {
    let d = ''
    modules.forEach((line, row) =>
      line.forEach((dark, col) => {
        if (dark) d += `M${col + quiet} ${row + quiet}h1v1h-1z`
      }),
    )
    return d
  }, [modules])
  return (
    <svg
      className="qr-code"
      data-testid="qr-code"
      data-modules={count}
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
