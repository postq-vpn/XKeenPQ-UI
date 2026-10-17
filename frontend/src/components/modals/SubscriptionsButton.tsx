import { IconChevronDown, IconPlus, IconWorld } from '@tabler/icons-react'
import { useEffect, useState, type ReactNode } from 'react'
import { apiCall } from '../../lib/api'
import type { XraySubscription } from '../../lib/types'
import { cn } from '../../lib/utils'
import { activeServerTag, serverName, subscriptionTitle } from './XraySubscriptions'

interface Props {
  /** Меняется, когда подписки могли измениться (закрыто окно, обновились конфиги) — кнопка перечитывает список. */
  refreshKey: string
  onOpen: () => void
  onAdd: () => void
}

/** Подписка, чей сервер показываем на кнопке: «Для прокси», иначе первая. */
function mainSubscription(subs: XraySubscription[]) {
  return subs.find((s) => s.proxy) ?? subs[0]
}

function PickerButton({ icon, caption, value, muted, onClick }: { icon: ReactNode; caption: string; value: string; muted?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-border bg-input-background hover:bg-muted focus-visible:ring-ring/50 flex max-w-full min-w-0 items-center gap-2 rounded-lg border px-3 py-1 text-left transition-colors outline-none focus-visible:ring-3"
    >
      <span className="text-chart-2 shrink-0">{icon}</span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-muted-foreground max-w-56 truncate text-[10px] tracking-wider uppercase">{caption}</span>
        <span className={cn('truncate text-sm font-medium', muted && 'text-muted-foreground')}>{value}</span>
      </span>
      <IconChevronDown size={16} className="text-muted-foreground ml-1 shrink-0" />
    </button>
  )
}

/** Кнопка подписок Xray в шапке «Конфигурация» в виде выбора сервера: показывает активный сервер основной подписки. */
export function SubscriptionsButton({ refreshKey, onOpen, onAdd }: Props) {
  const [subs, setSubs] = useState<XraySubscription[] | null>(null)

  useEffect(() => {
    let cancelled = false
    apiCall<{ success: boolean; subscriptions?: XraySubscription[] }>('GET', 'subscriptions')
      .then((res) => {
        if (!cancelled && res.success) setSubs(res.subscriptions ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  if (subs !== null && subs.length === 0) {
    return <PickerButton icon={<IconPlus size={18} />} caption="Подписка" value="Добавить подписку" muted onClick={onAdd} />
  }

  const main = subs ? mainSubscription(subs) : undefined
  const activeTag = main ? activeServerTag(main) : ''
  const server = main && activeTag ? serverName(main, activeTag) : ''
  const name = main ? subscriptionTitle(main) : 'Подписка'
  const caption = subs && subs.length > 1 ? `${name} (+${subs.length - 1}) · сервер` : `${name} · сервер`

  return (
    <PickerButton
      icon={<IconWorld size={18} />}
      caption={caption}
      value={subs === null ? 'Загрузка...' : server || 'Сервер не выбран'}
      muted={!server}
      onClick={onOpen}
    />
  )
}
