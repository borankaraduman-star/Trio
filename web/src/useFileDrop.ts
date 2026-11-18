import { useEffect, useRef, useState, type DragEvent } from 'react'

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

/**
 * Drag-and-drop of files onto an area, with a `dragging` flag for a visible
 * overlay. Only drags that carry files count (dragging text or a link inside
 * the page does nothing). `onFiles` null = no drop target.
 */
export function useFileDrop(onFiles: ((files: File[]) => void) | null): {
  dragging: boolean
  handlers: {
    onDragEnter?: (event: DragEvent) => void
    onDragOver?: (event: DragEvent) => void
    onDragLeave?: (event: DragEvent) => void
    onDrop?: (event: DragEvent) => void
  }
} {
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child crossed; count them.
  const depth = useRef(0)
  // A file dropped anywhere else must not make the browser navigate away to it.
  useEffect(() => {
    const guard = (event: globalThis.DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault()
    }
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => {
      window.removeEventListener('dragover', guard)
      window.removeEventListener('drop', guard)
    }
  }, [])
  if (!onFiles) return { dragging: false, handlers: {} }
  return {
    dragging,
    handlers: {
      onDragEnter: (event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        depth.current += 1
        setDragging(true)
      },
      onDragOver: (event) => {
        if (!hasFiles(event)) return
        // Without this the browser opens the file instead of dropping it here.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (event) => {
        if (!hasFiles(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      },
      onDrop: (event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        depth.current = 0
        setDragging(false)
        const files = Array.from(event.dataTransfer.files ?? [])
        if (files.length > 0) onFiles(files)
      },
    },
  }
}
