import { X as IconX } from 'lucide-react'
import { AnimatePresence, LazyMotion, domMax, m } from 'framer-motion'
import { useAppActions, useToasts } from '../../lib/store'
import type { ToastMessage } from '../../lib/types'

/** Больше трёх уведомлений разом не показываем: старые уходят. */
const MAX_VISIBLE = 3

/** Тип виден только по цвету (как в кабинете postq): обычное — текстом, ошибка — красным, предупреждение — жёлтым. */
const ACCENT = {
  success: 'text-[var(--rd-heading)]',
  warning: 'text-[var(--rd-warn-text)]',
  error: 'text-[var(--rd-error-text)]',
} as const

function ToastItem({ toast }: { toast: ToastMessage }) {
  const { dispatch } = useAppActions()
  const close = () => dispatch({ type: 'REMOVE_TOAST', id: toast.id })

  return (
    <m.div
      layout
      role={toast.type === 'error' ? 'alert' : 'status'}
      initial={{ opacity: 0, y: -16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } }}
      exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.2, ease: 'easeIn' } }}
      className="pointer-events-auto flex items-start gap-3 rounded-[var(--rd-radius-control)] bg-[var(--rd-surface)] py-3.5 pr-3 pl-5 shadow-[0_8px_32px_rgba(0,0,0,0.16)] ring-1 ring-[var(--rd-divider)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-1.5">
        {toast.title && <p className={`rd-body font-medium ${ACCENT[toast.type]}`}>{toast.title}</p>}
        <p className={`rd-body break-words ${toast.title ? 'text-[var(--rd-caption)]' : ACCENT[toast.type]}`}>{toast.body}</p>
        {toast.action && (
          <a
            href={toast.action.url}
            target="_blank"
            rel="noopener noreferrer"
            className="rd-meta rd-link-action w-fit text-[var(--rd-action)]"
          >
            Что нового
          </a>
        )}
      </div>
      <button
        type="button"
        onClick={close}
        aria-label="Закрыть уведомление"
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--rd-caption)] transition-colors hover:bg-[var(--rd-icon-btn)] hover:text-[var(--rd-heading)]"
      >
        <IconX size={16} />
      </button>
    </m.div>
  )
}

/** Уведомления по центру сверху, поверх шапки — как в кабинете postq. */
export function Toast() {
  const toasts = useToasts()
  // Стор кладёт новые в начало: показываем три свежих, новое сверху.
  const visible = toasts.slice(0, MAX_VISIBLE)

  return (
    <LazyMotion features={domMax}>
      <div
        role="region"
        aria-label="Уведомления"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-[calc(12px+env(safe-area-inset-top,0px))] z-[60] mx-auto flex w-[calc(100%-32px)] max-w-[400px] flex-col gap-2 sm:top-4"
      >
        <AnimatePresence initial={false}>
          {visible.map((toast) => (
            <ToastItem key={toast.id} toast={toast} />
          ))}
        </AnimatePresence>
      </div>
    </LazyMotion>
  )
}
