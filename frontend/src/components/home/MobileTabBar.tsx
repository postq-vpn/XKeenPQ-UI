import { CreditCard as IconSubscription, House as IconHome, Router as IconRouter } from 'lucide-react'
import { cn } from '../../lib/utils'

export type MobileTab = 'home' | 'subscription' | 'router'

export const MOBILE_TABS: readonly { id: MobileTab; label: string; icon: typeof IconHome }[] = [
  { id: 'home', label: 'Главная', icon: IconHome },
  { id: 'subscription', label: 'Подписка', icon: IconSubscription },
  { id: 'router', label: 'Роутер', icon: IconRouter },
]

/** Нижняя панель разделов на телефоне — как в кабинете: стекло, одна подложка скользит к выбранному разделу. */
export function MobileTabBar({ active, onSelect }: { active: MobileTab; onSelect: (tab: MobileTab) => void }) {
  const activeIndex = MOBILE_TABS.findIndex((tab) => tab.id === active)

  return (
    <nav
      aria-label="Разделы панели"
      className="rd-liquid-glass fixed z-50 flex h-(--mobile-nav-height) items-stretch rounded-[25px] p-2 lg:hidden"
      style={{
        bottom: 'var(--mobile-nav-offset)',
        left: 'max(16px, env(safe-area-inset-left, 0px))',
        right: 'max(16px, env(safe-area-inset-right, 0px))',
      }}
    >
      <div className="relative flex flex-1 items-stretch gap-1">
        <span
          aria-hidden
          className="rd-liquid-glass__active rd-liquid-glass__slider pointer-events-none absolute inset-y-0 left-0 rounded-[18px]"
          style={{
            width: `calc((100% - ${(MOBILE_TABS.length - 1) * 4}px) / ${MOBILE_TABS.length})`,
            transform: `translateX(calc(${Math.max(activeIndex, 0)} * (100% + 4px)))`,
          }}
        />
        {MOBILE_TABS.map(({ id, label, icon: Icon }) => {
          const isActive = id === active
          return (
            <button
              key={id}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(id)}
              className={cn(
                'relative flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-[18px] transition-[color,transform] duration-200 active:scale-[0.92]',
                isActive ? 'text-[var(--rd-heading)]' : 'text-[var(--rd-body)] hover:text-[var(--rd-heading)]'
              )}
            >
              <Icon size={22} strokeWidth={2} aria-hidden />
              <span className="max-w-full truncate px-1 text-[12px] leading-4 font-medium">{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
