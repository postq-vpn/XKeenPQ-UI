import { ArrowUpRight as IconArrowUpRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useRouterDevice } from '../modals/XraySubscriptions'
import { ProgressTrack } from '../postq/ui'
import { Ipv6Setting } from './Ipv6Setting'

type SystemStats = { memoryUsed: number; memoryTotal: number; cpuUsage: number }

const POLL_MS = 3000
const MB = 1048576

/** Блок «Роутер»: модель и прошивка, загрузка процессора и памяти (раз в 3 секунды), IPv6 в домашней сети. */
export function RouterBlock() {
  const [stats, setStats] = useState<SystemStats | null>(null)
  const device = useRouterDevice()

  useEffect(() => {
    let mounted = true
    const refresh = async () => {
      try {
        const result = await apiCall<{ success: boolean } & SystemStats>('GET', 'system')
        if (mounted && result.success) setStats(result)
      } catch {
        // Без статистики блок показывает прочерки.
      }
    }
    void refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [])

  return (
    <section className="rd-card flex flex-col gap-(--rd-space-card)" aria-labelledby="router-title">
      <div className="flex flex-col gap-(--rd-space-title)">
        <h2 id="router-title" className="rd-section">
          {/* Панель работает на самом роутере: его веб-интерфейс — тот же адрес без порта панели */}
          <a
            href={`${location.protocol}//${location.hostname}/`}
            target="_blank"
            rel="noreferrer"
            title="Открыть настройки роутера"
            className="group inline-flex items-center gap-1.5"
          >
            {device?.model || 'Роутер'}
            <IconArrowUpRight
              size={18}
              className="shrink-0 text-[var(--rd-caption)] transition-colors duration-150 ease-[ease] group-hover:text-[var(--rd-heading)]"
            />
          </a>
        </h2>
        {device?.os_version && <p className="rd-meta">Прошивка {device.os_version}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-(--rd-space-item)">
        <LoadTile label="Процессор" value={stats ? `${stats.cpuUsage.toFixed(0)}%` : '—'} percent={stats?.cpuUsage ?? 0} />
        <LoadTile
          label="Память"
          value={stats ? `${Math.round(stats.memoryUsed / MB)} МБ` : '—'}
          extra={stats ? `из ${Math.round(stats.memoryTotal / MB)}` : undefined}
          percent={stats?.memoryTotal ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0}
        />
      </dl>
      <Ipv6Setting />
    </section>
  )
}

/** Плитка загрузки: значение и полоса. */
function LoadTile({ label, value, extra, percent }: { label: string; value: string; extra?: string; percent: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-[var(--rd-radius-md)] bg-[var(--rd-field)] p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <dt className="rd-meta">{label}</dt>
        <dd className="flex min-w-0 items-baseline gap-1.5">
          <span className="rd-value text-[var(--rd-heading)]">{value}</span>
          {extra && <span className="rd-meta truncate">{extra}</span>}
        </dd>
      </div>
      <ProgressTrack percent={percent} label={label} />
    </div>
  )
}
