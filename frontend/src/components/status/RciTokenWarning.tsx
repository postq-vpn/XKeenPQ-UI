import { TriangleAlert as IconAlertTriangle, ChevronDown as IconChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppActions } from '../../lib/store'
import { cn } from '../../lib/utils'

/**
 * Прошивка роутера (KeeneticOS до 5.2) не пускает к RCI без токена доступа и не умеет его
 * выпускать (backend: /api/rci-status). Панель работает через консоль роутера, но XKeen без
 * токена ограничен. Помогает только обновление прошивки: после него панель выпустит токен сама.
 */
export function RciTokenWarning() {
  const { showToast } = useAppActions()
  const [shown, setShown] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    apiCall<{ success: boolean; firmware_update_needed?: boolean }>('GET', 'rci-status')
      .then((res) => setShown(!!(res.success && res.firmware_update_needed)))
      .catch(() => {
        /* старый backend без этого адреса — уведомления нет */
      })
  }, [])

  async function hide() {
    try {
      const res = await apiCall<{ success: boolean; error?: string }>('PATCH', 'settings', { gui: { hide_rci_hint: true } })
      if (!res.success) throw new Error(res.error || 'Не удалось сохранить настройку')
      setShown(false)
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }

  if (!shown) return null

  return (
    <section role="alert" className="rd-card flex flex-col gap-(--rd-space-group)">
      <div className="flex flex-col gap-(--rd-space-group) sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-(--rd-space-group)">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--rd-warn-bg)]">
            <IconAlertTriangle size={22} className="text-[var(--rd-warn-icon)]" />
          </span>
          <div className="flex min-w-0 flex-col gap-(--rd-space-title)">
            <span className="rd-body font-medium text-[var(--rd-heading)]">Обновите прошивку роутера до 5.2</span>
            <span className="rd-meta">На этой версии XKeen не получает доступ к роутеру, а в панели не включается IPv6.</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2 pl-[60px] sm:pl-0">
          <button type="button" className="rd-btn-soft" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            Как обновить
            <IconChevronDown size={18} className={cn('transition-transform', open && 'rotate-180')} />
          </button>
          <button
            type="button"
            className="rd-btn-soft bg-[var(--rd-chip)]! text-[var(--rd-body)]! hover:bg-[var(--rd-chip-hover)]!"
            onClick={() => void hide()}
          >
            Скрыть
          </button>
        </div>
      </div>
      {open && (
        <ol className="rd-meta flex list-decimal flex-col gap-1 pl-[80px] text-[var(--rd-body)]">
          <li>В веб-интерфейсе роутера откройте «Управление» → «Настройки системы» → вкладку «NDMS и обновления».</li>
          <li>
            В «Канале обновления» выберите «Предварительный» — версия 5.2 пока выходит в нём — и установите обновление. Роутер
            перезагрузится.
          </li>
          <li>После перезагрузки панель снова получит доступ к роутеру, и уведомление пропадёт.</li>
          <li>Если новая прошивка потребует токен доступа, панель выпустит его сама — тогда перезапустите XKeen.</li>
        </ol>
      )}
    </section>
  )
}
