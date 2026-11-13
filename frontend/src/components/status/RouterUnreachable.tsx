import { Button } from '@/components/ui/button'
import { probeRouter, type LoginInfo } from '@/lib/reachability'
import { cn } from '@/lib/utils'
import { RotateCw as IconRetry, WifiOff as IconWifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BrandLogo } from '../ui/postq-logo'

const RETRY_MS = 5000

/** Экран вместо панели, пока роутер не отвечает. Сам переспрашивает роутер: по таймеру, при возврате
 * в приложение и при появлении сети — и отдаёт ответ, как только роутер снова на связи. */
export function RouterUnreachable({ onReachable, overlay = false }: { onReachable: (info: LoginInfo) => void; overlay?: boolean }) {
  const [checking, setChecking] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const checkingRef = useRef(false)
  const onReachableRef = useRef(onReachable)
  useEffect(() => {
    onReachableRef.current = onReachable
  }, [onReachable])

  const check = useCallback(async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    setChecking(true)
    const info = await probeRouter()
    checkingRef.current = false
    setChecking(false)
    if (info) onReachableRef.current(info)
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void check()
    }, RETRY_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    const onOnline = () => {
      setOnline(true)
      void check()
    }
    const onOffline = () => setOnline(false)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [check])

  return (
    <div
      role="alertdialog"
      aria-labelledby="unreachable-title"
      aria-describedby="unreachable-text"
      className={cn(
        'bg-muted dark:bg-background flex min-h-dvh items-center justify-center p-4',
        overlay && 'fixed inset-0 z-[100] overflow-y-auto'
      )}
    >
      <div className="bg-card ring-foreground/10 mx-auto w-full max-w-md space-y-5 rounded-2xl border p-6 shadow-lg">
        <BrandLogo className="text-[28px]" />
        <div className="space-y-2">
          <h1 id="unreachable-title" className="flex items-center gap-2 text-lg font-semibold">
            <IconWifiOff size={20} aria-hidden="true" className="text-primary shrink-0" />
            {online ? 'Роутер недоступен' : 'Нет подключения к сети'}
          </h1>
          <p id="unreachable-text" className="text-muted-foreground text-sm text-pretty">
            {online
              ? `Панель не получает ответа от роутера (${location.host}). Если вы не дома — подключитесь к домашнему Wi-Fi. Если дома — проверьте, что роутер включён.`
              : 'Телефон не подключён ни к Wi-Fi, ни к мобильной сети. Панель откроется, когда связь появится.'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => void check()} disabled={checking}>
            <IconRetry size={16} aria-hidden="true" className={cn(checking && 'animate-spin')} />
            {checking ? 'Проверяем…' : 'Повторить'}
          </Button>
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {checking ? '' : 'Проверяем автоматически'}
          </span>
        </div>
      </div>
    </div>
  )
}
