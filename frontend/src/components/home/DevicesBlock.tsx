import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import {
  Check as IconCheck,
  ChevronDown as IconChevronDown,
  ChevronRight as IconChevronRight,
  Pencil as IconPencil,
  Search as IconSearch,
  X as IconX,
} from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppActions } from '../../lib/store'
import { cn } from '../../lib/utils'
import { plural } from '../postq/ui'

interface Device {
  mac: string
  name: string | null
  ip: string | null
  segment: string | null
  active: boolean
  ssid: string | null
  hostname: string | null
  last_seen: number | null
  vpn: boolean
  segment_vpn: boolean
  other_policy: string | null
}

interface DevicesResponse {
  success: boolean
  error?: string
  policy?: boolean
  devices?: Device[]
}

interface ChangeResponse {
  success: boolean
  error?: string
  changed?: number
  failed?: { mac: string; error: string }[]
  save_error?: string | null
}

/** Список в окне обновляется часто — видно, кто подключился; счётчик в карточке — реже. */
const POLL_OPEN_MS = 5_000
const POLL_CLOSED_MS = 30_000

const devicesWord = (n: number) => plural(n, ['устройство', 'устройства', 'устройств'])

function ago(seconds: number | null) {
  if (seconds === null) return 'не в сети'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 1) return 'был в сети только что'
  if (minutes < 60) return `был в сети ${minutes} мин назад`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `был в сети ${hours} ч назад`
  const days = Math.floor(hours / 24)
  return `был в сети ${days} ${plural(days, ['день', 'дня', 'дней'])} назад`
}

const title = (d: Device) => d.name ?? 'Без имени'

const byName = (a: Device, b: Device) =>
  Number(!a.name) - Number(!b.name) || title(a).localeCompare(title(b), 'ru') || a.mac.localeCompare(b.mac)
/** Сначала в сети, потом по имени. */
const byPresence = (a: Device, b: Device) => Number(b.active) - Number(a.active) || byName(a, b)

/** Список устройств с роутера и изменения в нём; `watching` — список на экране, обновлять чаще. */
function useDevices(watching: boolean) {
  const { showToast } = useAppActions()
  const [data, setData] = useState<DevicesResponse | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      setData(await apiCall<DevicesResponse>('GET', 'devices'))
    } catch {
      /* старый backend без этого адреса — блока нет */
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(load, watching ? POLL_OPEN_MS : POLL_CLOSED_MS)
    return () => clearInterval(timer)
  }, [load, watching])

  /** `true` — роутер принял изменение (хотя бы для части устройств). */
  async function apply(macs: string[], enabled: boolean) {
    if (macs.length === 0) return false
    setPending((s) => new Set([...s, ...macs]))
    // Сразу показываем новое положение, а список перечитываем после ответа роутера
    setData((d) => d && { ...d, devices: d.devices?.map((x) => (macs.includes(x.mac) && !x.segment_vpn ? { ...x, vpn: enabled } : x)) })
    try {
      const res = await apiCall<ChangeResponse>('POST', 'devices/vpn', { macs, enabled })
      if (!res.success) throw new Error(res.error || 'Не удалось изменить настройку')
      const failed = res.failed ?? []
      if (macs.length > 1 && res.changed) {
        showToast(`${res.changed} ${devicesWord(res.changed)} ${enabled ? 'теперь идут через VPN' : 'теперь идут напрямую'}`)
      }
      if (failed.length === 1) showToast(`Не получилось: ${failed[0].error}`, 'error')
      if (failed.length > 1) showToast(`Не получилось для ${failed.length} ${devicesWord(failed.length)}: ${failed[0].error}`, 'error')
      if (res.save_error) showToast(`Настройки роутера не сохранены и сбросятся после перезагрузки: ${res.save_error}`, 'error')
      return true
    } catch (e: any) {
      showToast(e.message, 'error')
      return false
    } finally {
      setPending((s) => new Set([...s].filter((m) => !macs.includes(m))))
      void load()
    }
  }

  async function rename(device: Device, name: string) {
    const previous = device.name
    setData((d) => d && { ...d, devices: d.devices?.map((x) => (x.mac === device.mac ? { ...x, name } : x)) })
    try {
      const res = await apiCall<{ success: boolean; error?: string; save_error?: string | null }>('POST', 'devices/name', {
        mac: device.mac,
        name,
      })
      if (!res.success) throw new Error(res.error || 'Не удалось переименовать')
      if (res.save_error) showToast(`Настройки роутера не сохранены и сбросятся после перезагрузки: ${res.save_error}`, 'error')
    } catch (e: any) {
      setData((d) => d && { ...d, devices: d.devices?.map((x) => (x.mac === device.mac ? { ...x, name: previous } : x)) })
      showToast(e.message, 'error')
    } finally {
      void load()
    }
  }

  return { data, pending, apply, rename }
}

type DevicesState = ReturnType<typeof useDevices>

/**
 * Карточка «Устройства» (backend: devices.rs): сколько идёт через VPN. На компьютере открывает
 * окно, на телефоне и планшете — отдельный экран (`onOpenPage`), как настройки.
 */
export function DevicesBlock({ onOpenPage }: { onOpenPage: () => void }) {
  const [open, setOpen] = useState(false)
  const state = useDevices(open)
  const { data } = state

  if (!data?.success) return null
  const devices = data.devices ?? []
  const viaVpn = devices.filter((d) => d.vpn).length

  function openList() {
    if (window.matchMedia('(min-width: 1024px)').matches) setOpen(true)
    else onOpenPage()
  }

  return (
    <section className="rd-card overflow-hidden p-0!" aria-label="Устройства">
      <button
        type="button"
        disabled={!data.policy}
        onClick={openList}
        className="group flex w-full items-center gap-(--rd-space-group) p-(--rd-space-card) text-left transition-colors enabled:hover:bg-[var(--rd-field)]/50"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-(--rd-space-title)">
          <span className="rd-section">Устройства</span>
          <span className="rd-meta">
            {!data.policy
              ? 'В роутере нет политики xkeen, через VPN идут все'
              : viaVpn === 0
                ? 'Все устройства выходят в интернет напрямую'
                : `Через VPN ${plural(viaVpn, ['идёт', 'идут', 'идут'])} ${viaVpn} ${devicesWord(viaVpn)}`}
          </span>
        </span>
        {data.policy && (
          <IconChevronRight size={20} className="shrink-0 text-[var(--rd-caption)] transition-transform group-hover:translate-x-0.5" />
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[min(90dvh,880px)] w-full max-w-[min(calc(100%-2rem),760px)]! flex-col gap-(--rd-space-group) overflow-hidden">
          <DialogHeader className="shrink-0 gap-(--rd-space-title)">
            <DialogTitle>Устройства через VPN</DialogTitle>
            <DialogDescription>{DESCRIPTION}</DialogDescription>
          </DialogHeader>
          <DevicesManager state={state} scroll />
        </DialogContent>
      </Dialog>
    </section>
  )
}

const DESCRIPTION = 'Остальные выходят в интернет напрямую. Изменения применяются сразу.'

/** Устройства на телефоне — отдельный экран. «Назад» — в шапке (AppHeader). */
export function DevicesPage() {
  const state = useDevices(true)
  return (
    <section className="rd-card flex flex-col gap-(--rd-space-group) max-sm:p-4" aria-labelledby="devices-page-title">
      <div className="flex flex-col gap-(--rd-space-title)">
        <h1 id="devices-page-title" className="rd-title">
          Устройства через VPN
        </h1>
        <p className="rd-meta">{DESCRIPTION}</p>
      </div>
      {state.data?.success ? (
        <DevicesManager state={state} />
      ) : (
        <p className="rd-meta py-10 text-center">{state.data?.error ?? 'Загружаю список устройств…'}</p>
      )}
    </section>
  )
}

/**
 * Поиск, фильтр по сетям и группы устройств. `scroll` — внутри окна: список прокручивается сам,
 * панель выбора прижата к низу окна; иначе прокручивается страница, а панель липнет к низу экрана.
 */
function DevicesManager({ state, scroll }: { state: DevicesState; scroll?: boolean }) {
  const { data, pending, apply, rename } = state
  const [query, setQuery] = useState('')
  const [segment, setSegment] = useState<string | null>(null)
  const [showOffline, setShowOffline] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  function closeSelection() {
    setSelecting(false)
    setSelected(new Set())
  }

  async function applySelected(enabled: boolean) {
    if (await apply([...selected], enabled)) closeSelection()
  }

  function toggleSelected(macs: string[], on: boolean) {
    setSelected((s) => {
      const next = new Set(s)
      macs.forEach((m) => (on ? next.add(m) : next.delete(m)))
      return next
    })
  }

  const devices = useMemo(() => data?.devices ?? [], [data])
  const segments = useMemo(() => [...new Set(devices.map((d) => d.segment).filter((s): s is string => !!s))], [devices])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return devices.filter(
      (d) => (!segment || d.segment === segment) && (!q || [d.name, d.hostname, d.ip, d.mac].some((v) => v?.toLowerCase().includes(q)))
    )
  }, [devices, query, segment])
  const viaVpn = filtered.filter((d) => d.vpn).sort(byPresence)
  const direct = filtered.filter((d) => !d.vpn && d.active).sort(byName)
  const offline = filtered.filter((d) => !d.vpn && !d.active).sort(byName)
  const offlineOpen = showOffline || !!query

  const rowProps = (d: Device) => ({
    device: d,
    pending: pending.has(d.mac),
    selecting,
    selected: selected.has(d.mac),
    onSelect: (on: boolean) => toggleSelected([d.mac], on),
    onToggle: (on: boolean) => void apply([d.mac], on),
    onRename: (name: string) => void rename(d, name),
  })
  const groupProps = (list: Device[]) => {
    const selectable = list.filter((d) => !d.segment_vpn).map((d) => d.mac)
    return {
      selecting,
      allSelected: selectable.length > 0 && selectable.every((m) => selected.has(m)),
      canSelect: selectable.length > 0,
      onSelectAll: (on: boolean) => toggleSelected(selectable, on),
    }
  }

  return (
    <>
      <div className="flex shrink-0 flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <IconSearch size={18} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[var(--rd-caption)]" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Имя, IP или MAC"
              aria-label="Поиск устройства"
              className="pl-10"
            />
          </div>
          <button
            type="button"
            aria-pressed={selecting}
            className="rd-body rd-link-action w-20 shrink-0 text-right font-medium text-[var(--rd-action)]"
            onClick={() => (selecting ? closeSelection() : setSelecting(true))}
          >
            {selecting ? 'Отмена' : 'Выбрать'}
          </button>
        </div>
        {segments.length > 1 && (
          <div role="group" aria-label="Сеть" className="flex gap-1 overflow-x-auto rounded-[14px] bg-[var(--rd-field)] p-1">
            {[null, ...segments].map((s) => (
              <button
                key={s ?? ''}
                type="button"
                aria-pressed={segment === s}
                onClick={() => setSegment(s)}
                className={cn(
                  'h-9 flex-1 cursor-pointer rounded-[10px] px-3 text-[15px] font-medium whitespace-nowrap transition-colors',
                  segment === s
                    ? 'bg-[var(--rd-surface)] text-[var(--rd-heading)] shadow-[0_2px_10px_rgba(0,0,0,0.06)] dark:bg-[var(--rd-chip-hover)]'
                    : 'text-[var(--rd-caption)] hover:text-[var(--rd-heading)]'
                )}
              >
                {s ?? 'Все'}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={cn('flex flex-col gap-(--rd-space-card)', scroll && '-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1')}>
        {viaVpn.length > 0 && (
          <DeviceGroup title="Через VPN" count={viaVpn.length} {...groupProps(viaVpn)}>
            {viaVpn.map((d) => (
              <DeviceRow key={d.mac} {...rowProps(d)} />
            ))}
          </DeviceGroup>
        )}
        {direct.length > 0 && (
          <DeviceGroup title="Напрямую, в сети" count={direct.length} {...groupProps(direct)}>
            {direct.map((d) => (
              <DeviceRow key={d.mac} {...rowProps(d)} />
            ))}
          </DeviceGroup>
        )}
        {offline.length > 0 && (
          <DeviceGroup
            title="Не в сети"
            count={offline.length}
            {...groupProps(offline)}
            collapsed={!offlineOpen}
            onToggleCollapsed={() => setShowOffline((v) => !v)}
          >
            {offline.map((d) => (
              <DeviceRow key={d.mac} {...rowProps(d)} />
            ))}
          </DeviceGroup>
        )}
        {filtered.length === 0 && <p className="rd-meta py-10 text-center">Ничего не найдено</p>}
      </div>

      {selecting && (
        <>
          {/* На экране телефона панель закреплена внизу — под ней не должен прятаться конец списка */}
          {!scroll && <div aria-hidden className="h-28" />}
          <div
            className={cn(
              'shrink-0',
              scroll
                ? 'border-t border-[var(--rd-divider)] pt-(--rd-space-group)'
                : 'fixed inset-x-0 bottom-0 z-40 border-t border-[var(--rd-divider)] bg-[var(--rd-surface)] px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]'
            )}
          >
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3">
              <p className="rd-meta text-center">
                {selected.size ? `Выбрано ${selected.size} ${devicesWord(selected.size)}` : 'Отметьте устройства в списке'}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="rd-btn-soft w-full bg-[var(--rd-chip)]! text-[var(--rd-body)]! hover:bg-[var(--rd-chip-hover)]!"
                  disabled={!selected.size || pending.size > 0}
                  onClick={() => void applySelected(false)}
                >
                  Напрямую
                </button>
                <button
                  type="button"
                  className="rd-btn-soft w-full"
                  disabled={!selected.size || pending.size > 0}
                  onClick={() => void applySelected(true)}
                >
                  {pending.size > 0 && <Spinner className="size-4" />}
                  Через VPN
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}

function DeviceGroup({
  title,
  count,
  selecting,
  allSelected,
  canSelect,
  onSelectAll,
  collapsed,
  onToggleCollapsed,
  children,
}: {
  title: string
  count: number
  selecting: boolean
  allSelected: boolean
  canSelect: boolean
  onSelectAll: (on: boolean) => void
  collapsed?: boolean
  onToggleCollapsed?: () => void
  children: ReactNode
}) {
  const heading = (
    <>
      {title}
      <span className="text-[var(--rd-caption)]">{count}</span>
    </>
  )
  return (
    <div className="flex flex-col gap-(--rd-space-item)">
      <div className="flex min-h-6 items-center justify-between gap-3 px-1">
        {onToggleCollapsed ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
            className="rd-meta flex items-center gap-1.5 font-medium text-[var(--rd-body)]"
          >
            {heading}
            <IconChevronDown size={16} className={cn('transition-transform', !collapsed && 'rotate-180')} />
          </button>
        ) : (
          <p className="rd-meta flex items-center gap-1.5 font-medium text-[var(--rd-body)]">{heading}</p>
        )}
        {selecting && canSelect && !collapsed && (
          <button
            type="button"
            className="rd-meta rd-link-action font-medium text-[var(--rd-action)]"
            onClick={() => onSelectAll(!allSelected)}
          >
            {allSelected ? 'Снять все' : 'Выбрать все'}
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="divide-y divide-[var(--rd-divider)] overflow-hidden rounded-[var(--rd-radius-md)] bg-[var(--rd-field)]">
          {children}
        </div>
      )}
    </div>
  )
}

function DeviceRow({
  device,
  pending,
  selecting,
  selected,
  onSelect,
  onToggle,
  onRename,
}: {
  device: Device
  pending: boolean
  selecting: boolean
  selected: boolean
  onSelect: (on: boolean) => void
  onToggle: (on: boolean) => void
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const id = `device-${device.mac}`
  const details = device.active ? (device.ip ?? 'в сети') : ago(device.last_seen)
  const note = device.segment_vpn
    ? 'Через VPN идёт вся эта сеть — исключить можно в роутере, в «Приоритетах подключений»'
    : device.other_policy
      ? `Своя политика «${device.other_policy}» — при включении заменится`
      : null

  function startEditing() {
    setDraft(device.name ?? '')
    setEditing(true)
  }
  function save() {
    const name = draft.trim()
    setEditing(false)
    if (name && name !== device.name) onRename(name)
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') save()
    if (e.key === 'Escape') {
      e.stopPropagation()
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <Input
          autoFocus
          value={draft}
          maxLength={64}
          onChange={(e) => setDraft(e.target.value.replace(/["\\]/g, ''))}
          onKeyDown={onKeyDown}
          placeholder={device.hostname ?? 'Имя устройства'}
          aria-label="Имя устройства"
          className="min-w-0 flex-1"
        />
        <button
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-[var(--rd-radius-sm)] text-[var(--rd-action)] transition-colors hover:bg-[var(--rd-chip)] disabled:opacity-40"
          aria-label="Сохранить имя"
          disabled={!draft.trim()}
          onClick={save}
        >
          <IconCheck size={18} />
        </button>
        <button
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-[var(--rd-radius-sm)] text-[var(--rd-caption)] transition-colors hover:bg-[var(--rd-chip)] hover:text-[var(--rd-heading)] disabled:opacity-40"
          aria-label="Отменить"
          onClick={() => setEditing(false)}
        >
          <IconX size={18} />
        </button>
      </div>
    )
  }

  const body = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            'rd-body truncate font-medium',
            !device.name ? 'text-[var(--rd-caption)]' : device.active ? 'text-[var(--rd-heading)]' : 'text-[var(--rd-body)]'
          )}
        >
          {title(device)}
        </span>
        {!selecting && (
          <button
            type="button"
            onClick={startEditing}
            aria-label={device.name ? `Переименовать ${device.name}` : 'Задать имя'}
            className="flex size-7 shrink-0 items-center justify-center text-[var(--rd-caption)] transition-colors hover:text-[var(--rd-heading)] [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
          >
            <IconPencil size={14} />
          </button>
        )}
      </span>
      <span className="rd-meta truncate">{details}</span>
      {!device.name && <span className="rd-meta truncate">{device.mac}</span>}
      {note && <span className="rd-meta text-[var(--rd-warn-text)]">{note}</span>}
    </span>
  )

  if (selecting) {
    return (
      <label
        htmlFor={id}
        className={cn(
          'flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors',
          selected && 'bg-[var(--rd-action-soft)]/40',
          device.segment_vpn && 'cursor-default opacity-60'
        )}
      >
        <Checkbox id={id} checked={selected} disabled={device.segment_vpn} onCheckedChange={(v) => onSelect(!!v)} className="size-5" />
        {body}
      </label>
    )
  }

  return (
    <div className="group flex items-center gap-3 px-4 py-3">
      {body}
      <Switch
        id={id}
        checked={device.vpn}
        disabled={pending || device.segment_vpn}
        onCheckedChange={(next) => onToggle(next)}
        aria-label={`${title(device)}: через VPN`}
      />
    </div>
  )
}
