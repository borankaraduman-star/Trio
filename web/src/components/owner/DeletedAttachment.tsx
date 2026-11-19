import { FileIcon } from '../icons2'

/** CONTRACT-V6-OPS §4: what is left of a file its uploader deleted. */
export function DeletedAttachment({ filename }: { filename: string }) {
  return (
    <div className="attachment-deleted" data-testid="attachment-deleted" title={filename}>
      <FileIcon size={18} />
      <span>
        dosya silindi <span className="attachment-deleted-name">· {filename}</span>
      </span>
    </div>
  )
}
