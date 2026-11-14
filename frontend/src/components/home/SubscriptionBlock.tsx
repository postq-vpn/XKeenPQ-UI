import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowUpRight as IconArrowUpRight, ChevronDown as IconChevronDown, Ellipsis as IconDots } from 'lucide-react'
import type { SubscriptionsState } from '../../lib/useSubscriptions'
import type { XraySubscription } from '../../lib/types'
import { cn } from '../../lib/utils'
import { formatBytesRu, InfinityMark, Notice, plural, ProgressTrack, StatTile } from '../postq/ui'

const DAY_MS = 86_400_000
/** За сколько дней до окончания подписки предупреждать о продлении. */
const EXPIRY_WARN_DAYS = 5

/** Пункт меню как в кабинете (SubscriptionMenu): заголовок и подпись, без иконок. */
const MENU_ITEM = 'flex-col items-start gap-1 px-4 py-3'

/** Кабинет и поддержка PostqVPN (те же адреса, что в postq-cabinet/src/components/postq/links.ts). */
const CABINET_URL = 'https://web.postq.space'
const CABINET_SUPPORT_URL = 'https://web.postq.space/support'
const SUPPORT_BOT_URL = 'https://t.me/postq_vpn_support_bot'

const days = (n: number) => `${n} ${plural(n, ['день', 'дня', 'дней'])}`

/**
 * Блок «Подписка» PostqVPN: статус и срок, трафик, обновить подписку,
 * личный кабинет и поддержка. Панель работает только с подпиской PostqVPN.
 */
export function SubscriptionBlock({
  state,
  onAdd,
  onEdit,
  onDelete,
}: {
  state: SubscriptionsState
  onAdd: () => void
  onEdit: (sub: XraySubscription) => void
  onDelete: (sub: XraySubscription) => void
}) {
  const { subs, loading } = state

  if (loading) return <SubscriptionSkeleton />

  if (subs.length === 0)
    return (
      <section className="rd-card flex flex-col gap-(--rd-space-card)" aria-labelledby="sub-empty-title">
        <div className="flex flex-col gap-(--rd-space-item)">
          <h2 id="sub-empty-title" className="rd-title">
            Подключите PostqVPN
          </h2>
          <p className="rd-body max-w-[42ch] text-[var(--rd-body)]">
            Скопируйте ссылку на подписку в личном кабинете и вставьте её сюда. VPN заработает на всех устройствах дома.
          </p>
        </div>
        <div className="flex flex-col gap-(--rd-space-item)">
          <button type="button" className="rd-btn w-full" onClick={onAdd}>
            Вставить ссылку
          </button>
          <a href={CABINET_URL} target="_blank" rel="noopener noreferrer" className="rd-btn-tile rd-btn-tile--muted min-h-14">
            Личный кабинет
            <IconArrowUpRight size={18} className="shrink-0 text-[var(--rd-caption)]" />
          </a>
        </div>
      </section>
    )

  return (
    <div className="flex flex-col gap-(--rd-space-grid)">
      {subs.map((sub) => (
        <SubscriptionCard key={sub.tag} sub={sub} state={state} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  )
}

function SubscriptionCard({
  sub,
  state,
  onEdit,
  onDelete,
}: {
  sub: XraySubscription
  state: SubscriptionsState
  onEdit: (sub: XraySubscription) => void
  onDelete: (sub: XraySubscription) => void
}) {
  const { updatingTags } = state
  const anyUpdating = updatingTags.length > 0
  const info = sub.userinfo
  const used = (info?.upload ?? 0) + (info?.download ?? 0)
  const total = info?.total ?? 0

  const expire = info?.expire ?? 0
  const daysLeft = expire ? Math.ceil((expire * 1000 - Date.now()) / DAY_MS) : null
  const expired = daysLeft !== null && daysLeft <= 0
  const expiresSoon = daysLeft !== null && !expired && daysLeft <= EXPIRY_WARN_DAYS
  const endDate = expire ? new Date(expire * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : ''
  const term = !expire ? 'Бессрочная' : expired ? `Закончилась ${endDate}` : `До ${endDate} · ещё ${days(daysLeft!)}`
  const titleId = `sub-${sub.tag}`

  return (
    <section className="rd-card flex flex-col gap-(--rd-space-card)" aria-labelledby={titleId}>
      <div className="flex items-start justify-between gap-(--rd-space-group)">
        <div className="flex min-w-0 flex-col gap-(--rd-space-title)">
          <h2 id={titleId} className="rd-title">
            {expired ? 'Подписка закончилась' : 'Подписка активна'}
          </h2>
          <p
            className={cn(
              'rd-body',
              expired ? 'text-[var(--rd-error-text)]' : expiresSoon ? 'text-[var(--rd-warn-text)]' : 'text-[var(--rd-caption)]'
            )}
          >
            {term}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="rd-icon-btn data-popup-open:bg-[var(--rd-chip-hover)]"
                aria-label="Управление подпиской"
                title="Управление подпиской"
                disabled={anyUpdating}
              />
            }
          >
            <IconDots size={20} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="w-[280px] max-w-[calc(100vw-32px)]">
            <DropdownMenuItem className={MENU_ITEM} onSelect={() => onEdit(sub)}>
              <span className="rd-body text-[var(--rd-heading)]">Изменить</span>
              <span className="rd-meta">Ссылка и автообновление</span>
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onSelect={() => onDelete(sub)}>
              <span className="rd-body text-[var(--rd-error-text)]">Удалить</span>
              <span className="rd-meta">VPN перестанет работать</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {(sub.last_error || expired || expiresSoon) && (
        <div className="flex flex-col gap-(--rd-space-group)">
          {sub.last_error && <Notice tone="error" title="Не удалось обновить подписку" text={sub.last_error} />}
          {expired && (
            <Notice tone="error" title="VPN перестал работать" text="Продлите подписку в личном кабинете, потом обновите её здесь." />
          )}
          {expiresSoon && (
            <Notice tone="warning" title="Скоро закончится" text="Продлите подписку в личном кабинете, чтобы VPN не отключился." />
          )}
        </div>
      )}

      <StatTile
        label="Трафик"
        value={total > 0 ? `${formatBytesRu(used)} из ${formatBytesRu(total)}` : used > 0 ? formatBytesRu(used) : '—'}
        footer={
          total > 0 ? (
            <ProgressTrack percent={(used / total) * 100} label="Трафик" />
          ) : (
            <div className="flex justify-end">
              <InfinityMark className="text-[var(--rd-action)]" />
              <span className="sr-only">Без ограничения</span>
            </div>
          )
        }
      />

      <div className="flex flex-col gap-(--rd-space-item)">
        <PostqLinks />
      </div>
    </section>
  )
}

/** Пункт меню поддержки — как пункты меню в кабинете. */
function SupportItem({ href, title, subtitle }: { href: string; title: string; subtitle: string }) {
  return (
    <DropdownMenuItem className={MENU_ITEM} render={<a href={href} target="_blank" rel="noopener noreferrer" />}>
      <span className="rd-body text-[var(--rd-heading)]">{title}</span>
      <span className="rd-meta">{subtitle}</span>
    </DropdownMenuItem>
  )
}

/** Личный кабинет и поддержка (в кабинете или в Telegram). */
function PostqLinks() {
  return (
    // На телефоне в половину строки «Личный кабинет» со стрелкой не помещается — кнопки друг под другом.
    <div className="grid grid-cols-1 gap-(--rd-space-item) sm:grid-cols-2 [&>*]:px-(--rd-space-group) [&>*]:whitespace-nowrap">
      <a href={CABINET_URL} target="_blank" rel="noopener noreferrer" className="rd-btn-tile rd-btn-tile--muted min-h-14">
        Личный кабинет
        <IconArrowUpRight size={18} className="shrink-0 text-[var(--rd-caption)]" />
      </a>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="rd-btn-tile rd-btn-tile--muted min-h-14 data-popup-open:bg-[var(--rd-chip-hover)] [&>svg]:transition-transform [&>svg]:duration-300 data-popup-open:[&>svg]:rotate-180"
            />
          }
        >
          Поддержка
          <IconChevronDown size={18} className="shrink-0 text-[var(--rd-caption)]" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-[280px] max-w-[calc(100vw-32px)]">
          <SupportItem href={CABINET_SUPPORT_URL} title="В личном кабинете" subtitle="Чат на web.postq.space" />
          <SupportItem href={SUPPORT_BOT_URL} title="В Telegram" subtitle="@postq_vpn_support_bot" />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function SubscriptionSkeleton() {
  return (
    <section className="rd-card flex flex-col gap-(--rd-space-card)" aria-busy="true" aria-label="Загрузка подписки">
      <div className="flex flex-col gap-(--rd-space-title)">
        <Skeleton className="h-8 w-60 rounded-lg" />
        <Skeleton className="h-5 w-40 rounded-lg" />
      </div>
      <Skeleton className="h-[112px] rounded-[var(--rd-radius-md)] sm:h-[124px]" />
      <div className="grid grid-cols-1 gap-(--rd-space-item) sm:grid-cols-2">
        <Skeleton className="h-14 rounded-[var(--rd-radius-control)]" />
        <Skeleton className="h-14 rounded-[var(--rd-radius-control)]" />
      </div>
    </section>
  )
}
