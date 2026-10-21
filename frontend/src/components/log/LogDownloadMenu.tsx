import { Button } from '@/components/ui/button'
import { IconDownload } from '@tabler/icons-react'

const download = () => {
  const a = document.createElement('a')
  a.href = '/api/logs/download?file=all'
  // Имя файла задаёт сервер (xray-logs-<дата>.zip)
  a.download = ''
  a.click()
}

/** «Скачать лог» на главной: оба журнала Xray одним zip-архивом (backend: xray_log.rs). */
export function LogDownloadMenu() {
  return (
    <Button variant="outline" onClick={download} title="error.log и access.log одним архивом">
      <IconDownload data-icon="inline-start" />
      Скачать лог
    </Button>
  )
}
