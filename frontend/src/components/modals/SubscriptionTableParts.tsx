import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { type ComponentProps, type ReactNode } from 'react'
import type { ProxySubscriptionInfo } from '../../lib/types'
import { cn } from '../../lib/utils'

const COLUMN_COUNT = 6
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
const BADGE_TONES = {
  blue: 'bg-blue-500/10! text-blue-400!',
  green: 'bg-green-500/10! text-green-400!',
  emerald: 'bg-emerald-500/10! text-emerald-400!',
  orange: 'bg-orange-500/10! text-orange-400!',
  muted: 'bg-white/5! text-white/40!',
}

type BadgeTone = keyof typeof BADGE_TONES

function parseDate(value?: string | number) {
  if (!value) return null
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateTime(value?: string | number) {
  return (
    parseDate(value)?.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }) ?? '—'
  )
}

export function formatBytes(bytes: number) {
  const exponent = bytes > 0 ? Math.min(Math.floor(Math.log2(bytes) / 10), BYTE_UNITS.length - 1) : 0
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(exponent === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${BYTE_UNITS[exponent]}`
}

export function formatTraffic(info?: ProxySubscriptionInfo) {
  const used = (info?.Upload ?? 0) + (info?.Download ?? 0)
  const total = info?.Total ?? 0
  if (total > 0) return `${formatBytes(used)} / ${formatBytes(total)}`
  return used > 0 ? formatBytes(used) : '—'
}

export function ProviderBadge({ tone = 'blue', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <Badge variant="ghost" className={cn('rounded-full border-none px-2 text-xs', BADGE_TONES[tone])}>
      {children}
    </Badge>
  )
}

export function ActionButton({ busy, icon, ...props }: ComponentProps<typeof Button> & { busy: boolean; icon: ReactNode }) {
  return (
    <Button variant="ghost" size="icon-xs" className="hover:bg-transparent! hover:text-blue-400" {...props}>
      {busy ? <Spinner className="size-4" /> : icon}
    </Button>
  )
}

export function LoadingTable() {
  return (
    <div className="space-y-2 p-5">
      {Array.from({ length: 6 }, (_, row) => (
        <div key={row} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${COLUMN_COUNT}, minmax(0, 1fr))` }}>
          {Array.from({ length: COLUMN_COUNT }, (_, column) => (
            <Skeleton key={column} className="h-10 rounded-md" />
          ))}
        </div>
      ))}
    </div>
  )
}
