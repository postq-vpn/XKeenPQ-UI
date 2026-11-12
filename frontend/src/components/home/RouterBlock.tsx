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

  const memPercent = stats?.memoryTotal ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0

  return (
    <section className="rd-card flex flex-col gap-(--rd-space-card)" aria-labelledby="router-title">
      <div className="flex flex-col gap-(--rd-space-title)">
        <h2 id="router-title" className="rd-section">
          {device?.model || 'Роутер'}
        </h2>
        {device?.os_version && <p className="rd-meta">Прошивка {device.os_version}</p>}
      </div>
      <dl className="flex flex-col gap-(--rd-space-group)">
        <Row label="Процессор" value={stats ? `${stats.cpuUsage.toFixed(0)}%` : '—'} percent={stats?.cpuUsage ?? 0} />
        <Row
          label="Память"
          value={stats ? `${Math.round(stats.memoryUsed / MB)} из ${Math.round(stats.memoryTotal / MB)} МБ` : '—'}
          percent={memPercent}
        />
      </dl>
      <Ipv6Setting />
    </section>
  )
}

function Row({ label, value, percent }: { label: string; value: string; percent: number }) {
  return (
    <div className="flex flex-col gap-(--rd-space-item)">
      <div className="flex items-baseline justify-between gap-(--rd-space-group)">
        <dt className="rd-body text-[var(--rd-body)]">{label}</dt>
        <dd className="rd-body font-medium text-[var(--rd-heading)]">{value}</dd>
      </div>
      <ProgressTrack percent={percent} label={label} />
    </div>
  )
}
