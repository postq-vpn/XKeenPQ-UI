import { CircleAlert as IconAlertCircle, Clock as IconClock } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Примитивы дизайн-системы postq (как в postq-cabinet/src/components/postq/ui.tsx).
 * Роли текста — в globals.css: rd-title, rd-section, rd-value, rd-body, rd-meta.
 */

/** Серая плитка внутри карточки (Figma «Устройства», «Трафик»): подпись, значение, низ. */
export function StatTile({ label, value, footer }: { label: ReactNode; value: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-[112px] min-w-0 flex-col gap-3 rounded-[var(--rd-radius-md)] bg-[var(--rd-field)] p-(--rd-space-tile) sm:min-h-[124px]">
      <div className="flex flex-col gap-(--rd-space-title)">
        <span className="rd-body truncate text-[var(--rd-caption)]">{label}</span>
        <span className="rd-value truncate text-[var(--rd-heading)]">{value}</span>
      </div>
      {footer && <div className="mt-auto">{footer}</div>}
    </div>
  )
}

/** 8px полоса: розовая на бледно-розовой дорожке. */
export function ProgressTrack({ percent, label }: { percent: number; label?: string }) {
  const value = Math.max(0, Math.min(100, percent))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 w-full overflow-hidden rounded-[var(--rd-radius-sm)] bg-[var(--rd-help)]"
    >
      <div
        className="h-full rounded-[var(--rd-radius-sm)] bg-[var(--rd-action)] transition-[width] duration-500"
        style={{ width: `${value}%` }}
      />
    </div>
  )
}

/** Цветное уведомление внутри карточки (Figma «Доступ приостановлен»). */
export function Notice({ tone, title, text }: { tone: 'error' | 'warning'; title: string; text?: ReactNode }) {
  const Icon = tone === 'error' ? IconAlertCircle : IconClock
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-(--rd-space-group) rounded-[var(--rd-radius-md)] p-(--rd-space-group)',
        tone === 'error' ? 'bg-[var(--rd-error-bg)]' : 'bg-[var(--rd-warn-bg)]'
      )}
    >
      <Icon size={22} className={cn('mt-px shrink-0', tone === 'error' ? 'text-[var(--rd-error)]' : 'text-[var(--rd-warn-icon)]')} />
      <div className="flex min-w-0 flex-1 flex-col gap-(--rd-space-title)">
        <span className={cn('rd-body font-medium', tone === 'error' ? 'text-[var(--rd-error-text)]' : 'text-[var(--rd-heading)]')}>
          {title}
        </span>
        {text && <span className="rd-meta break-words text-[var(--rd-body)]">{text}</span>}
      </div>
    </div>
  )
}

/** Знак «без ограничений» — та же форма, что cabinet/infinity.svg в кабинете, крупнее; толщина линии не масштабируется. */
export function InfinityMark({ className }: { className?: string }) {
  return (
    <svg width="32" height="18" viewBox="0 0 18 10" fill="none" aria-hidden className={className} overflow="visible">
      <path
        d="M9 5C9 5 6.80914 9 4.6 9C2.39086 9 1 7.20912 1 5C1 2.79086 2.39086 1 4.6 1C6.80914 1 9 5 9 5ZM9 5C9 5 11.1909 9 13.4 9C15.6091 9 17 7.20912 17 5C17 2.79086 15.6091 1 13.4 1C11.1909 1 9 5 9 5Z"
        stroke="currentColor"
        strokeWidth="2.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

// ---------- форматирование ----------

const BYTE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ']

export function formatBytesRu(bytes: number) {
  const exponent = bytes > 0 ? Math.min(Math.floor(Math.log2(bytes) / 10), BYTE_UNITS.length - 1) : 0
  const value = bytes / 1024 ** exponent
  const digits = exponent === 0 || value >= 100 ? 0 : 1
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: digits })} ${BYTE_UNITS[exponent]}`
}

export function plural(n: number, forms: [string, string, string]) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}

/** Интервал автообновления подписки: 43200 → «раз в 12 часов». */
export function formatInterval(seconds: number) {
  if (!seconds) return null
  if (seconds % 86400 === 0) {
    const d = seconds / 86400
    return d === 1 ? 'раз в сутки' : `раз в ${d} ${plural(d, ['день', 'дня', 'дней'])}`
  }
  if (seconds % 3600 === 0) {
    const h = seconds / 3600
    return h === 1 ? 'раз в час' : `раз в ${h} ${plural(h, ['час', 'часа', 'часов'])}`
  }
  const m = Math.max(1, Math.round(seconds / 60))
  return `раз в ${m} ${plural(m, ['минуту', 'минуты', 'минут'])}`
}

/** Имя сервера из подписки: «🇳🇱 Нидерланды | Ai» → основная часть и пометка провайдера. */
export function splitServerName(name: string) {
  const [main, ...rest] = name.split('|')
  return { main: main.trim(), note: rest.join('|').trim() }
}
