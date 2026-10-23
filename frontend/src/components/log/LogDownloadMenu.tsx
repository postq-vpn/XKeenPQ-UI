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
    <Button
      variant="outline"
      onClick={download}
      title="error.log и access.log одним архивом"
      // На телефоне кнопка компактнее, чтобы помещалась в одну строку с заголовком
      className="max-sm:h-7 max-sm:gap-1 max-sm:px-2 max-sm:text-xs max-sm:[&_svg]:size-3.5"
    >
      <IconDownload data-icon="inline-start" />
      Скачать лог
    </Button>
  )
}
