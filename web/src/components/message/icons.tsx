import type { ReactNode } from 'react'

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

interface IconProps {
  size?: number
}

export function SmilePlusIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
      <line x1="19" y1="2" x2="19" y2="8" />
      <line x1="16" y1="5" x2="22" y2="5" />
    </Icon>
  )
}

export function ReplyIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </Icon>
  )
}

export function EditIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Icon>
  )
}

export function TrashIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </Icon>
  )
}

export function PinIcon({ size, off = false }: IconProps & { off?: boolean }) {
  return (
    <Icon size={size}>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </Icon>
  )
}

export function MoreIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Icon>
  )
}

export function CopyIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  )
}
