import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ArrowLeft as IconArrowLeft, ChevronDown as IconChevronDown } from 'lucide-react'
import { useAppContext } from '../../lib/store'
import { cn } from '../../lib/utils'
import { isXkeenFile, tabLabel } from '../configuration/ConfigPanel'

interface Props {
  /** Открытый файл; null — открыт журнал. */
  activeFile: string | null
  logActive: boolean
  onHome: () => void
  onSelectLog: () => void
  onSelectFile: (file: string) => void
}

function useGroups() {
  const { state } = useAppContext({ includeConfigs: true })
  return {
    xray: state.configs.filter((c) => !isXkeenFile(c.file)),
    xkeen: state.configs.filter((c) => isXkeenFile(c.file)),
  }
}

const ROW =
  'flex w-full cursor-pointer items-center gap-(--rd-space-item) rounded-[12px] px-4 py-2.5 text-left text-[15px] leading-5 transition-colors'

/**
 * Техническое меню на десктопе: карточка слева — «На главную», журнал, конфиги Xray и списки XKeen.
 * Пункты как в меню кабинета: текст без иконок, выбранный — на подложке поля.
 */
export function TechNav({ activeFile, logActive, onHome, onSelectLog, onSelectFile }: Props) {
  const { xray, xkeen } = useGroups()
  const row = (key: string, label: string, active: boolean, onClick: () => void, dirty = false, title?: string) => (
    <button
      key={key}
      type="button"
      title={title}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        ROW,
        active
          ? 'bg-[var(--rd-field)] font-medium text-[var(--rd-heading)]'
          : 'text-[var(--rd-body)] hover:bg-[var(--rd-field)] hover:text-[var(--rd-heading)]'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {dirty && <span className="size-2 shrink-0 rounded-full bg-[var(--rd-warn-icon)]" aria-label="не сохранено" />}
    </button>
  )
  const group = (title: string, children: React.ReactNode) => (
    <div className="flex flex-col gap-1">
      <p className="rd-meta px-4 pb-1">{title}</p>
      {children}
    </div>
  )

  return (
    <nav aria-label="Техническое меню" className="rd-card flex flex-col gap-(--rd-space-group) p-(--rd-space-item)!">
      <button
        type="button"
        onClick={onHome}
        className={cn(ROW, 'text-[var(--rd-caption)] hover:bg-[var(--rd-field)] hover:text-[var(--rd-heading)]')}
      >
        <IconArrowLeft size={18} className="shrink-0" />
        На главную
      </button>
      <div className="flex flex-col gap-1">{row('log', 'Журнал Xray', logActive, onSelectLog)}</div>
      {xray.length > 0 &&
        group(
          'Конфиги Xray',
          xray.map((c) => row(c.file, tabLabel(c.file), activeFile === c.file, () => onSelectFile(c.file), c.isDirty, c.file))
        )}
      {xkeen.length > 0 &&
        group(
          'Списки XKeen',
          xkeen.map((c) => row(c.file, tabLabel(c.file), activeFile === c.file, () => onSelectFile(c.file), c.isDirty, c.file))
        )}
    </nav>
  )
}

/** То же меню на телефоне и планшете: кнопка с текущим разделом и выпадающий список. */
export function TechNavMenu({ activeFile, logActive, onHome, onSelectLog, onSelectFile }: Props) {
  const { xray, xkeen } = useGroups()
  const label = activeFile ? tabLabel(activeFile) : logActive ? 'Журнал Xray' : 'Техническое меню'
  const item = (key: string, text: string, active: boolean, onClick: () => void) => (
    <DropdownMenuItem key={key} onSelect={onClick} className={cn('px-4 py-2.5', active && 'font-medium text-[var(--rd-heading)]')}>
      {text}
      {active && <span className="ml-auto size-2 rounded-full bg-[var(--rd-action)]" aria-hidden />}
    </DropdownMenuItem>
  )
  const label_ = (text: string) => <p className="rd-meta px-4 pt-2 pb-1">{text}</p>

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="rd-btn-tile rd-btn-tile--muted min-h-11 w-full justify-between px-4 text-[15px] lg:hidden [&>svg]:transition-transform data-popup-open:[&>svg]:rotate-180"
          />
        }
      >
        <span className="truncate">{label}</span>
        <IconChevronDown size={18} className="shrink-0 text-[var(--rd-caption)]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="max-h-[70dvh] w-(--anchor-width) overflow-y-auto">
        {item('home', '← На главную', false, onHome)}
        {item('log', 'Журнал Xray', logActive, onSelectLog)}
        {xray.length > 0 && label_('Конфиги Xray')}
        {xray.map((c) => item(c.file, tabLabel(c.file), activeFile === c.file, () => onSelectFile(c.file)))}
        {xkeen.length > 0 && label_('Списки XKeen')}
        {xkeen.map((c) => item(c.file, tabLabel(c.file), activeFile === c.file, () => onSelectFile(c.file)))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
