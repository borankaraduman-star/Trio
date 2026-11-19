import './download-link.css'

/**
 * "Masaüstü uygulamasını indir" (CONTRACT-V6-DOWNLOAD): a link to the public
 * download page, on the join screen and in Ayarlar. Not shown inside the
 * desktop app itself.
 */
export function DownloadLink({ className }: { className?: string }) {
  // Any bridge at all means the desktop app, even one older than today's.
  if ((globalThis as { trioDesktop?: unknown }).trioDesktop !== undefined) return null
  return (
    <a
      href="/indir"
      target="_blank"
      rel="noopener"
      className={className ? `download-link ${className}` : 'download-link'}
      data-testid="download-link"
    >
      Masaüstü uygulamasını indir
    </a>
  )
}
