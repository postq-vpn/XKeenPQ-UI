import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconCheck, IconChevronDown, IconDatabase, IconFileCode, IconFileText, IconTerminal2 } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { useAppContext } from '../../lib/store'
import { isXkeenFile, tabLabel } from './ConfigPanel'

interface Props {
  /** Открытый файл; null — открыта страница «Подписка и серверы» или журнал. */
  activeFile: string | null
  /** Открыт журнал. */
  logActive: boolean
  onSelectServers: () => void
  onSelectLog: () => void
  onSelectFile: (file: string) => void
}

/** Меню «Технические файлы»: переключает главный блок на подписки или на редактор выбранного файла. */
export function TechFilesMenu({ activeFile, logActive, onSelectServers, onSelectLog, onSelectFile }: Props) {
  const { state } = useAppContext({ includeConfigs: true })
  const xray = state.configs.filter((c) => !isXkeenFile(c.file))
  const xkeen = state.configs.filter((c) => isXkeenFile(c.file))
  const check = (on: boolean) => (on ? <IconCheck className="ml-auto" /> : null)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline">
            <IconFileCode data-icon="inline-start" />
            {activeFile ? tabLabel(activeFile) : logActive ? 'Журнал' : 'Технические файлы'}
            <IconChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="max-h-[70dvh] min-w-60 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onSelectServers}>
            <IconDatabase /> Подписка и серверы
            {check(activeFile === null && !logActive)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onSelectLog}>
            <IconTerminal2 /> Журнал
            {check(logActive)}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {xray.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Конфиги Xray</DropdownMenuLabel>
              {xray.map((c) => (
                <DropdownMenuItem key={c.file} onClick={() => onSelectFile(c.file)} title={c.file}>
                  <IconFileCode /> {tabLabel(c.file)}
                  {c.isDirty && <span className="size-1.5 rounded-full bg-amber-400" />}
                  {check(activeFile === c.file)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        {xkeen.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Списки XKeen</DropdownMenuLabel>
              {xkeen.map((c) => (
                <DropdownMenuItem key={c.file} onClick={() => onSelectFile(c.file)} title={c.file}>
                  <IconFileText /> {tabLabel(c.file)}
                  {c.isDirty && <span className="size-1.5 rounded-full bg-amber-400" />}
                  {check(activeFile === c.file)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ListProps {
  onSelectLog: () => void
  onSelectFile: (file: string) => void
}

/** Вкладка «Техническое меню» в настройках: журнал, конфиги Xray и списки XKeen. */
export function TechMenuList({ onSelectLog, onSelectFile }: ListProps) {
  const { state } = useAppContext({ includeConfigs: true })
  const xray = state.configs.filter((c) => !isXkeenFile(c.file))
  const xkeen = state.configs.filter((c) => isXkeenFile(c.file))
  const item = (key: string, icon: ReactNode, label: string, onClick: () => void, title?: string) => (
    <button
      key={key}
      type="button"
      title={title}
      onClick={onClick}
      className="hover:bg-muted/50 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm [&_svg]:size-4 [&_svg]:shrink-0"
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
  const group = (title: string, children: ReactNode) => (
    <div className="py-1">
      <p className="text-muted-foreground px-2 pt-3 pb-1 text-xs font-medium tracking-wider uppercase">{title}</p>
      {children}
    </div>
  )

  return (
    <div className="py-1">
      {group('Журнал', item('log', <IconTerminal2 />, 'Журнал Xray', onSelectLog))}
      {xray.length > 0 &&
        group(
          'Конфиги Xray',
          xray.map((c) => item(c.file, <IconFileCode />, tabLabel(c.file), () => onSelectFile(c.file), c.file))
        )}
      {xkeen.length > 0 &&
        group(
          'Списки XKeen',
          xkeen.map((c) => item(c.file, <IconFileText />, tabLabel(c.file), () => onSelectFile(c.file), c.file))
        )}
    </div>
  )
}
