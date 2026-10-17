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
