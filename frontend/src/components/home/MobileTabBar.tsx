import { CreditCard as IconSubscription, House as IconHome, Router as IconRouter } from 'lucide-react'
import { cn } from '../../lib/utils'

export type MobileTab = 'home' | 'subscription' | 'router'

type FilledIcon = (props: { size: number }) => React.JSX.Element

export const MOBILE_TABS: readonly { id: MobileTab; label: string; icon: typeof IconHome; filled: FilledIcon }[] = [
  { id: 'home', label: 'Главная', icon: IconHome, filled: HomeFilled },
  { id: 'subscription', label: 'Подписка', icon: IconSubscription, filled: CardFilled },
  { id: 'router', label: 'Роутер', icon: IconRouter, filled: RouterFilled },
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
        {MOBILE_TABS.map(({ id, label, icon: Icon, filled: Filled }) => {
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
              {/* Обе иконки на месте, меняются в такт с подложкой (globals.css, .rd-tab-icon) */}
              <span className="rd-tab-icon" data-active={isActive || undefined}>
                <Icon size={22} strokeWidth={2} aria-hidden className="rd-tab-icon__outline" />
                <span className="rd-tab-icon__filled">
                  <Filled size={22} />
                </span>
              </span>
              <span className="max-w-full truncate px-1 text-[12px] leading-4 font-medium">{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

/* Залитые иконки выбранного раздела: те же формы, что у lucide (House, CreditCard, Router), с той же
   обводкой 2px — внешний край совпадает с контурной иконкой. Вырезы — ровно пустые места контура:
   проём двери со скруглённым верхом до земли (как house.fill), полоса карты внутри боковых краёв (y 9–11),
   точки-индикаторы роутера (r 1 в 6,18 и 10,18). */

function FilledSvg({ size, id, cutout, children }: { size: number; id: string; cutout: React.ReactNode; children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="white" />
        {cutout}
      </mask>
      <g mask={`url(#${id})`} fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  )
}

function HomeFilled({ size }: { size: number }) {
  return (
    <FilledSvg size={size} id="tab-home-cut" cutout={<path d="M9.5 23V14a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v9z" fill="black" />}>
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </FilledSvg>
  )
}

function CardFilled({ size }: { size: number }) {
  return (
    <FilledSvg size={size} id="tab-card-cut" cutout={<rect x="3" y="9" width="18" height="2" fill="black" />}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
    </FilledSvg>
  )
}

function RouterFilled({ size }: { size: number }) {
  return (
    <FilledSvg
      size={size}
      id="tab-router-cut"
      cutout={
        <>
          <circle cx="6" cy="18" r="1" fill="black" />
          <circle cx="10" cy="18" r="1" fill="black" />
        </>
      }
    >
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <path d="M15 10v4M17.84 7.17a4 4 0 0 0-5.66 0M20.66 4.34a8 8 0 0 0-11.31 0" fill="none" />
    </FilledSvg>
  )
}
