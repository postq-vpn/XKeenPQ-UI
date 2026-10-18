import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { IconChevronDown, IconDownload } from '@tabler/icons-react'

const LOG_FILES = ['error.log', 'access.log']

const download = (file: string) => {
  const a = document.createElement('a')
  a.href = `/api/logs/download?file=${encodeURIComponent(file)}`
  a.download = `xray-${file}`
  a.click()
}

/** «Скачать лог» на главной: файлы журнала Xray (backend: xray_log.rs). */
export function LogDownloadMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline">
            <IconDownload data-icon="inline-start" />
            Скачать лог
            <IconChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-44">
        {LOG_FILES.map((f) => (
          <DropdownMenuItem key={f} onClick={() => download(f)}>
            <IconDownload /> {f}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
