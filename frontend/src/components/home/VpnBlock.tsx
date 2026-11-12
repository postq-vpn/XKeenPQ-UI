import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Check as IconCheck, Download as IconDownload, Power as IconPower, RefreshCw as IconRefresh } from 'lucide-react'
import { Fragment, useEffect } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext } from '../../lib/store'
import type { SubscriptionsState } from '../../lib/useSubscriptions'
import type { XraySubscription } from '../../lib/types'
import { cn } from '../../lib/utils'
import { isNotRecommended, splitRecommended, withoutAutoServers } from '../modals/AutoServers'
import { activeServerTag, serverName, type PingResult } from '../modals/XraySubscriptions'
import { splitServerName } from '../postq/ui'
import { PostqMark } from '../ui/postq-logo'

const STATUS_POLL_MS = 3000
/** Пинг — реальный запрос через сервер (backend ping.rs): медленным считаем от 800 мс. */
const SLOW_PING_MS = 800

const downloadLog = () => {
  const a = document.createElement('a')
  a.href = '/api/logs/download?file=all'
  // Имя файла задаёт сервер (xray-logs-<дата>.zip)
  a.download = ''
  a.click()
}

/**
 * Блок «VPN»: работает ли VPN и через какой сервер. Переключатель, выбор сервера,
 * внизу — журнал для поддержки.
 */
export function VpnBlock({
  state,
  onRefreshStatus,
  onAddSubscription,
}: {
  state: SubscriptionsState
  onRefreshStatus: () => void
  onAddSubscription: () => void
}) {
  const app = useAppContext()
  const { dispatch, showToast } = app
  const { serviceStatus, pendingText } = app.state
  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending' || serviceStatus === 'loading'

  // Статус сервиса: роутер мог запустить или остановить Xray сам.
  useEffect(() => {
    const timer = setInterval(() => {
      if (serviceStatus !== 'pending') onRefreshStatus()
    }, STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [serviceStatus, onRefreshStatus])

  async function control(action: 'start' | 'stop' | 'hardRestart') {
    const labels = {
      start: ['Включаю…', 'VPN включён'],
      stop: ['Выключаю…', 'VPN выключен'],
      hardRestart: ['Перезапускаю…', 'VPN перезапущен'],
    } as const
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: labels[action][0] })
    const result = await apiCall<any>('POST', 'control', { action }).catch((e) => ({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }))
    showToast(result.success ? labels[action][1] : `${result.output || result.error}`, result.success ? 'success' : 'error')
    if (action !== 'stop') dispatch({ type: 'SET_SERVICE_STATUS', status: result.success ? 'running' : 'stopped' })
    onRefreshStatus()
  }

  const { subs, loading, current } = state
  const primarySub = subs.find((s) => withoutAutoServers(s.server_list).length > 0)
  const route = primarySub ? describeRoute(primarySub, current) : null

  const title = isPending ? pendingText || 'Проверяю…' : isRunning ? 'VPN включён' : 'VPN выключен'
  const caption = isPending
    ? 'Это займёт несколько секунд'
    : !isRunning
      ? 'Устройства выходят в интернет напрямую'
      : (route ?? (subs.length === 0 && !loading ? 'Нет подписки — серверов пока нет' : 'Сайты из списков идут через VPN'))

  return (
    <section
      className="rd-card rd-vpn-card flex flex-col gap-(--rd-space-card)"
      data-state={isPending ? 'pending' : isRunning ? 'running' : 'stopped'}
      aria-labelledby="vpn-title"
    >
      <div className="flex items-center justify-between gap-(--rd-space-group)">
        <div className="flex min-w-0 flex-col gap-(--rd-space-title)">
          <h2 id="vpn-title" className="rd-title" aria-live="polite">
            {title}
          </h2>
          <p className="rd-meta truncate">{caption}</p>
        </div>
        <div className="flex shrink-0 items-center gap-(--rd-space-group)">
          {isRunning && (
            <button
              type="button"
              className="rd-icon-btn max-sm:hidden"
              onClick={() => void control('hardRestart')}
              disabled={isPending}
              aria-label="Перезапустить VPN"
              title="Перезапустить VPN"
            >
              <IconRefresh size={20} />
            </button>
          )}
          <button
            type="button"
            aria-pressed={isRunning}
            aria-label={isRunning ? 'Выключить VPN' : 'Включить VPN'}
            title={isRunning ? 'Выключить VPN' : 'Включить VPN'}
            className="rd-power"
            disabled={isPending}
            onClick={() => void control(isRunning ? 'stop' : 'start')}
          >
            <span className="rd-sonar" aria-hidden>
              <span />
            </span>
            {isPending ? (
              <Spinner className="size-7" />
            ) : (
              // Выключен — значок питания; при включении он превращается в знак PostqVPN (globals.css, .rd-power__*).
              <span className="rd-power__icons" aria-hidden>
                <IconPower size={30} strokeWidth={2.25} className="rd-power__off" />
                <PostqMark width={30} height={32} className="rd-power__on md:h-[34px] md:w-8" />
              </span>
            )}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-(--rd-space-group)">
          <Skeleton className="h-6 w-24 rounded-lg" />
          <div className="grid grid-cols-1 gap-(--rd-space-item) sm:grid-cols-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14 rounded-[var(--rd-radius-sm)]" />
            ))}
          </div>
        </div>
      ) : subs.length === 0 ? (
        <div className="flex flex-col items-start gap-(--rd-space-group) rounded-[var(--rd-radius-md)] bg-[var(--rd-field)] p-(--rd-space-card)">
          <p className="rd-body text-[var(--rd-body)]">Серверы появятся, когда вы добавите подписку.</p>
          <button type="button" className="rd-btn-soft" onClick={onAddSubscription}>
            Добавить подписку
          </button>
        </div>
      ) : (
        subs.map((sub) => <ServerPicker key={sub.tag} sub={sub} state={state} withTitle={subs.length > 1} />)
      )}

      <button type="button" className="rd-btn-tile rd-btn-tile--muted" onClick={downloadLog} title="error.log и access.log одним архивом">
        <IconDownload size={20} />
        Скачать журнал для поддержки
      </button>
    </section>
  )
}

/** «Авто, сейчас 🇳🇱 Нидерланды» или «Через 🇩🇪 Германия». */
function describeRoute(sub: XraySubscription, current: Record<string, string>) {
  const tag = sub.primary ? activeServerTag(sub) : current[sub.tag]
  const name = tag ? splitServerName(serverName(sub, tag)).main : null
  if (!sub.primary) return name ? `Авто, сейчас ${name}` : 'Авто: самый быстрый рабочий сервер'
  return name ? `Через ${name}` : null
}

/** Серверы подписки: «Авто» и серверы, российские — в конце отдельной группой. */
function ServerPicker({ sub, state, withTitle }: { sub: XraySubscription; state: SubscriptionsState; withTitle: boolean }) {
  const { savingServers, pings, ping, current, selectServer } = state
  const all = withoutAutoServers(sub.server_list)
  const { recommended, notRecommended } = splitRecommended(all)
  const servers = [...recommended, ...notRecommended]
  const busy = savingServers === sub.tag
  const active = activeServerTag(sub)
  const anyPinging = all.some((s) => pings[s.tag]?.loading)
  const autoCurrent = !sub.primary && current[sub.tag] ? current[sub.tag] : undefined

  return (
    <div className="flex flex-col gap-(--rd-space-group)">
      <div className="flex items-center justify-between gap-(--rd-space-group)">
        <h3 className="rd-section flex items-center gap-(--rd-space-item)">
          {withTitle ? `Сервер · ${sub.title?.trim() || sub.tag}` : 'Сервер'}
          {busy && <Spinner className="size-4 text-[var(--rd-caption)]" />}
        </h3>
        {all.length > 0 && (
          <button
            type="button"
            className="rd-link-action rd-meta flex items-center gap-1.5 text-[var(--rd-action)] disabled:opacity-50"
            disabled={anyPinging}
            onClick={() => void ping(all)}
          >
            {anyPinging && <Spinner className="size-4" />}
            Проверить пинг
          </button>
        )}
      </div>

      {all.length === 0 ? (
        <p className="rd-body text-[var(--rd-caption)]">Список серверов ещё не получен — обновите подписку.</p>
      ) : (
        <div role="radiogroup" aria-label="Сервер VPN" className="grid grid-cols-1 gap-(--rd-space-item) sm:grid-cols-2">
          <button
            type="button"
            role="radio"
            aria-checked={!sub.primary}
            disabled={busy}
            className="rd-server min-h-[64px] sm:col-span-2"
            onClick={() => void selectServer(sub, '')}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-(--rd-space-title)">
              <span className="rd-body font-medium">Авто</span>
              <span className="rd-meta truncate">
                {autoCurrent ? `сейчас ${splitServerName(serverName(sub, autoCurrent)).main}` : 'самый быстрый из работающих'}
              </span>
            </span>
            {autoCurrent && <Ping result={pings[autoCurrent]} />}
            {!sub.primary && <IconCheck size={20} strokeWidth={3} className="shrink-0 text-[var(--rd-action)]" />}
          </button>

          {servers.map((s, i) => {
            const selected = !!sub.primary && s.tag === active
            const first = isNotRecommended(s) && (i === 0 || !isNotRecommended(servers[i - 1]))
            const { main, note } = splitServerName(serverName(sub, s.tag))
            return (
              <Fragment key={s.tag}>
                {first && (
                  <p className="rd-meta pt-(--rd-space-item) sm:col-span-2">
                    Медленнее остальных — выбирайте, только если другие не работают
                  </p>
                )}
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy}
                  className="rd-server"
                  onClick={() => void selectServer(sub, s.tag)}
                >
                  <span className="rd-body min-w-0 flex-1 truncate">
                    {main}
                    {note && <span className="ml-2 text-[var(--rd-caption)]">{note}</span>}
                  </span>
                  <Ping result={pings[s.tag]} />
                  {selected && <IconCheck size={20} strokeWidth={3} className="shrink-0 text-[var(--rd-action)]" />}
                </button>
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Пинг одним цветом; выделяется только медленный сервер и сервер без ответа. */
function Ping({ result }: { result?: PingResult }) {
  if (!result) return null
  if (result.loading) return <Spinner className="size-4 shrink-0 text-[var(--rd-placeholder)]" />
  if (result.ms != null)
    return <span className={cn('rd-meta shrink-0', result.ms >= SLOW_PING_MS && 'text-[var(--rd-warn-text)]')}>{result.ms} мс</span>
  const udp = result.error?.startsWith('UDP')
  return (
    <span className={cn('rd-meta shrink-0', !udp && 'text-[var(--rd-error-text)]')} title={result.error}>
      {udp ? 'н/д' : 'не отвечает'}
    </span>
  )
}
