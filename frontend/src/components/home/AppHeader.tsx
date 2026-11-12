import { Download as IconDownload, LogOut as IconLogout, Settings as IconSettings } from 'lucide-react'

/** Толщина линии иконок в пилюлях шапки — как в шапке кабинета (headphones-bold). */
const PILL_STROKE = 2.25

import { useAppContext } from '../../lib/store'
import { PostqLogo } from '../ui/postq-logo'

/**
 * Шапка как в кабинете postq: матовая «пилюля» с логотипом слева,
 * отдельные пилюли справа — обновления, настройки, выход. Тема — только в настройках.
 */
export function AppHeader({
  onOpenSettings,
  onOpenUpdate,
  onLogout,
  onHome,
}: {
  onOpenSettings: () => void
  onOpenUpdate: (core: 'self' | 'xray') => void
  onLogout: () => void
  onHome: () => void
}) {
  const { state } = useAppContext({ includeSettings: true })
  const { version, isOutdatedUI, isOutdatedCore, settings } = state
  const hasUpdate = isOutdatedUI || isOutdatedCore

  return (
    <header className="sticky top-(--rd-space-grid) z-40 mb-[calc(var(--rd-space-head)-var(--rd-space-grid))] flex items-center gap-(--rd-space-grid)">
      <div className="mr-auto flex min-w-0 items-center gap-(--rd-space-grid)">
        <a
          href="/"
          onClick={(e) => {
            // Главная — без перезагрузки страницы; Ctrl/Cmd-клик по-прежнему открывает новую вкладку.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
            e.preventDefault()
            onHome()
          }}
          aria-label="PostqVPN — на главную"
          className="rd-pill min-w-0 px-4 sm:px-6"
        >
          <PostqLogo width={119} height={24} className="block sm:h-8 sm:w-[159px]" />
        </a>
      </div>

      {version && (
        <button
          type="button"
          className="rd-pill"
          // Вкладка с обновлением, если оно есть только у Xray; иначе — панель.
          onClick={() => onOpenUpdate(!isOutdatedUI && isOutdatedCore ? 'xray' : 'self')}
          aria-label={hasUpdate ? 'Обновления: есть новая версия' : 'Обновления'}
          title={hasUpdate ? 'Доступна новая версия' : 'Версии панели и Xray'}
        >
          <IconDownload size={20} strokeWidth={PILL_STROKE} />
          <span className="max-md:hidden">Обновления</span>
          {hasUpdate && <span className="absolute top-3 right-3 size-2 rounded-full bg-[var(--rd-action)] md:static" aria-hidden />}
        </button>
      )}
      <button type="button" className="rd-pill" onClick={onOpenSettings} aria-label="Настройки">
        <IconSettings size={20} strokeWidth={PILL_STROKE} />
        <span className="max-md:hidden">Настройки</span>
      </button>
      {settings.authEnabled && (
        <button type="button" className="rd-pill" onClick={onLogout} aria-label="Выйти">
          <IconLogout size={20} strokeWidth={PILL_STROKE} />
        </button>
      )}
    </header>
  )
}
