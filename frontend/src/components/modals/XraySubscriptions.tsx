import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { ChevronDown as IconChevronDown, RefreshCw as IconRefresh } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { apiCall } from '../../lib/api'
import { useAppActions } from '../../lib/store'
import type { XraySubscription, XraySubscriptionServer } from '../../lib/types'
import { cn } from '../../lib/utils'
import { formatBytesRu, formatInterval, Notice, splitServerName } from '../postq/ui'
import { splitRecommended, withoutAutoServers } from './AutoServers'

/** Подписка всегда запрашивается с этим User-Agent (backend: subscriptions::USER_AGENT). */
export const XRAY_USER_AGENT = 'Netcraze'
/** Платформа устройства (backend: subscriptions::DEVICE_OS). */
export const XRAY_DEVICE_OS = 'Router'

export const CLIENT_FINGERPRINTS = ['chrome', 'firefox', 'safari', 'iOS', 'android', 'edge', '360', 'qq', 'random']

interface ApiResult {
  success: boolean
  error?: string
  restart_error?: string | null
}

interface PreviewServer {
  tag: string
  name?: string
  protocol: string
  address?: string
  port?: number
  disabled?: boolean
}

interface PreviewResult {
  servers: PreviewServer[]
  skipped: string[]
  userinfo: XraySubscription['userinfo']
}

interface PreviewResponse extends PreviewResult {
  title?: string | null
  suggested_tag?: string
}

export function randomHwid(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => n.toString(16).padStart(2, '0').toUpperCase()).join('')
}

export function createXraySubscription(url: string, existingTags: string[] = []): XraySubscription {
  let idx = 1
  while (existingTags.includes(`subscription_${idx}`)) idx++
  return {
    tag: `subscription_${idx}`,
    url,
    interval: 43200,
    // Пустой — роутер подставит свой постоянный HWID: повторное добавление не займёт новый слот
    hwid: '',
    filter: '',
    exclude_filter: '',
    exclude_type: '',
    fingerprint: '',
    disabled_servers: [],
    primary: '',
  }
}

interface RouterDevice {
  model: string
  os_version: string
}

// Модель и версия ОС не меняются за время работы страницы — спрашиваем backend один раз.
let routerDevicePromise: Promise<RouterDevice | null> | null = null

function loadRouterDevice() {
  routerDevicePromise ??= apiCall<ApiResult & Partial<RouterDevice>>('GET', 'subscriptions/device')
    .then((res) => (res.success ? { model: res.model ?? '', os_version: res.os_version ?? '' } : null))
    .catch(() => null)
    .then((device) => {
      if (!device) routerDevicePromise = null
      return device
    })
  return routerDevicePromise
}

/** Модель роутера и версия ОС из RCI (подставляются backend'ом, если поля пустые). */
export function useRouterDevice() {
  const [device, setDevice] = useState<RouterDevice | null>(null)
  useEffect(() => {
    let alive = true
    void loadRouterDevice().then((d) => alive && setDevice(d))
    return () => {
      alive = false
    }
  }, [])
  return device
}

/** Пресеты автообновления; нестандартное значение с роутера добавляется отдельным пунктом. */
const INTERVAL_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: 'Только вручную' },
  { value: 3600, label: 'Раз в час' },
  { value: 21600, label: 'Раз в 6 часов' },
  { value: 43200, label: 'Раз в 12 часов' },
  { value: 86400, label: 'Раз в сутки' },
]

function intervalOptions(current: number) {
  if (INTERVAL_PRESETS.some((p) => p.value === current)) return INTERVAL_PRESETS
  const custom = formatInterval(current)
  return [...INTERVAL_PRESETS, { value: current, label: custom ? custom[0].toUpperCase() + custom.slice(1) : `${current} с` }]
}

/** Поле формы: подпись, контрол, пояснение под ним. */
function FormField({ label, htmlFor, hint, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-(--rd-space-item)">
      <label htmlFor={htmlFor} className="rd-body font-medium text-[var(--rd-heading)]">
        {label}
      </label>
      {children}
      {hint && <p className="rd-meta">{hint}</p>}
    </div>
  )
}

/** Строка «подпись — значение» для того, что меняет только роутер. */
function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-(--rd-space-group) py-(--rd-space-item)">
      <dt className="rd-meta">{label}</dt>
      <dd className="rd-body min-w-0 truncate text-right text-[var(--rd-heading)]">{value}</dd>
    </div>
  )
}

interface EditorProps {
  initial: XraySubscription
  isEdit: boolean
  onSaved: (sub: XraySubscription) => void
  initialTab?: 'form' | 'servers'
}

/**
 * Окно «Изменить подписку»: вкладки «Настройки» и «Серверы», внизу «Сохранить».
 * Родитель задаёт только окно; вкладки, прокрутку и кнопку рисует редактор.
 */
export function XraySubscriptionEditor({ initial, isEdit, onSaved, initialTab = 'form' }: EditorProps) {
  const { showToast } = useAppActions()
  const [form, setForm] = useState(initial)
  const [tab, setTab] = useState<'form' | 'servers'>(initialTab)
  const [advanced, setAdvanced] = useState(false)
  const device = useRouterDevice()
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  // Тег новой подписки берём из её названия, пока пользователь не правил его вручную.
  const [tagTouched, setTagTouched] = useState(isEdit)
  const ids = useId()

  // Фильтра подключений нет: подписка всегда отдаёт все серверы.
  const payload = useMemo(() => ({ ...form, filter: '', exclude_filter: '', exclude_type: '' }), [form])

  function update<K extends keyof XraySubscription>(key: K, value: XraySubscription[K]) {
    if (key === 'tag') setTagTouched(true)
    setForm((prev) => ({ ...prev, [key]: value }))
    setPreview(null)
    setPreviewError(null)
  }

  // «--» отделяет имя сервера в теге, в названии подписки его быть не должно.
  const tagValid = /^[A-Za-z0-9_-]{1,64}$/.test(form.tag.trim()) && !form.tag.includes('--')
  const urlValid = /^https?:\/\//i.test(form.url.trim())
  const canSubmit = !busy && tagValid && urlValid && !!form.hwid.trim()
  const canSave = canSubmit && (!preview || preview.servers.length > 0)

  useEffect(() => {
    if (initialTab === 'servers' || !isEdit) void runPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runPreview() {
    if (!canSubmit) return
    setBusy('preview')
    setPreviewError(null)
    try {
      const autoTag = !tagTouched
      const res = await apiCall<ApiResult & Partial<PreviewResponse>>('POST', 'subscriptions/preview', { ...payload, auto_tag: autoTag })
      if (!res.success) throw new Error(res.error)
      const suggested = autoTag ? res.suggested_tag : undefined
      setForm((prev) => ({
        ...prev,
        title: res.title ?? prev.title,
        tag: suggested && suggested !== prev.tag ? suggested : prev.tag,
        disabled_servers: [],
      }))
      setPreview({ servers: withoutAutoServers(res.servers), skipped: res.skipped ?? [], userinfo: res.userinfo })
    } catch (e: any) {
      setPreview(null)
      setPreviewError(e.message || 'Не удалось получить подписку')
    } finally {
      setBusy(null)
    }
  }

  function changeTab(next: 'form' | 'servers') {
    setTab(next)
    if (next === 'servers' && !preview && !previewError) void runPreview()
  }

  async function save() {
    setBusy('save')
    try {
      const res = await apiCall<ApiResult & { subscription?: XraySubscription }>(isEdit ? 'PATCH' : 'POST', 'subscriptions', {
        ...payload,
        // Тег не правили вручную — он будет следовать за названием подписки.
        auto_tag: isEdit ? payload.auto_tag : !tagTouched,
      })
      if (!res.success || !res.subscription) throw new Error(res.error)
      showToast(`Подписка ${isEdit ? 'сохранена' : 'добавлена'}: серверов ${res.subscription.servers ?? 0}`)
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      onSaved(res.subscription)
    } catch (e: any) {
      showToast(e.message || 'Не удалось сохранить', 'error')
    } finally {
      setBusy(null)
    }
  }

  const serverCount = preview?.servers.length ?? withoutAutoServers(initial.server_list).length
  const info = preview?.userinfo ?? initial.userinfo
  const used = (info?.upload ?? 0) + (info?.download ?? 0)
  const tabs = [
    { id: 'form' as const, label: 'Настройки' },
    { id: 'servers' as const, label: serverCount ? `Серверы · ${serverCount}` : 'Серверы' },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-(--rd-space-card)">
      <div role="tablist" aria-label="Разделы подписки" className="grid shrink-0 grid-cols-2 gap-1 rounded-[14px] bg-[var(--rd-field)] p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => changeTab(t.id)}
            className={cn(
              'h-10 cursor-pointer rounded-[10px] text-[15px] font-medium transition-colors',
              tab === t.id
                ? 'bg-[var(--rd-surface)] text-[var(--rd-heading)] shadow-[0_2px_10px_rgba(0,0,0,0.06)] dark:bg-[var(--rd-chip-hover)]'
                : 'text-[var(--rd-caption)] hover:text-[var(--rd-heading)]'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="-mx-(--rd-space-card) min-h-0 flex-1 scrollbar-thin overflow-y-auto px-(--rd-space-card)">
        {tab === 'form' ? (
          <div className="flex flex-col gap-(--rd-space-card) pb-1">
            <FormField label="Ссылка на подписку" htmlFor={`${ids}-url`}>
              <Input
                id={`${ids}-url`}
                value={form.url}
                onChange={(e) => update('url', e.target.value)}
                placeholder="https://…"
                aria-invalid={!urlValid}
                inputMode="url"
                spellCheck={false}
              />
            </FormField>

            <FormField
              label="Автообновление"
              hint="Панель сама перекачивает список серверов. Обновить вручную можно в любой момент на главной."
            >
              <Select
                value={String(form.interval)}
                items={Object.fromEntries(intervalOptions(form.interval).map((o) => [String(o.value), o.label]))}
                onValueChange={(v) => update('interval', Number(v))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {intervalOptions(form.interval).map((o) => (
                      <SelectItem key={o.value} value={String(o.value)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </FormField>

            <div className="flex flex-col border-t border-[var(--rd-divider)] pt-(--rd-space-card)">
              <button
                type="button"
                aria-expanded={advanced}
                aria-controls={`${ids}-adv`}
                onClick={() => setAdvanced((v) => !v)}
                className="flex w-full cursor-pointer items-center justify-between gap-(--rd-space-group) text-left"
              >
                <span className="flex flex-col gap-(--rd-space-title)">
                  <span className="rd-section">Дополнительно</span>
                  <span className="rd-meta">Тег, отпечаток TLS и данные устройства</span>
                </span>
                <IconChevronDown
                  size={20}
                  className={cn('shrink-0 text-[var(--rd-caption)] transition-transform duration-300', advanced && 'rotate-180')}
                />
              </button>

              <div id={`${ids}-adv`} className="rd-disclosure" data-open={advanced}>
                <div className="rd-disclosure__inner">
                  <div className="flex flex-col gap-(--rd-space-card) pt-(--rd-space-card)">
                    <FormField
                      label="Тег"
                      htmlFor={`${ids}-tag`}
                      hint={
                        isEdit
                          ? 'Задаётся при добавлении. Серверы получают теги вида «тег--сервер».'
                          : 'Латиница, цифры, «-» и «_», без «--». Серверы получат теги вида «тег--сервер».'
                      }
                    >
                      <Input
                        id={`${ids}-tag`}
                        value={form.tag}
                        disabled={isEdit}
                        aria-invalid={!isEdit && !tagValid}
                        onChange={(e) => update('tag', e.target.value)}
                      />
                    </FormField>

                    <FormField label="Отпечаток TLS" hint="Каким браузером представляться серверу. Обычно провайдер задаёт его сам.">
                      <Select
                        value={form.fingerprint || '__inherit__'}
                        items={{ __inherit__: 'Как у провайдера', ...Object.fromEntries(CLIENT_FINGERPRINTS.map((fp) => [fp, fp])) }}
                        onValueChange={(v) => update('fingerprint', v === '__inherit__' ? '' : (v as string))}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="__inherit__">Как у провайдера</SelectItem>
                            {CLIENT_FINGERPRINTS.map((fp) => (
                              <SelectItem key={fp} value={fp}>
                                {fp}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </FormField>

                    <FormField
                      label="Идентификатор устройства (x-hwid)"
                      htmlFor={`${ids}-hwid`}
                      hint={
                        form.hwid_locked
                          ? 'Привязан к роутеру и не меняется, поэтому роутер всегда занимает одно место в лимите устройств.'
                          : 'Если его поменять, роутер займёт ещё одно место в лимите устройств.'
                      }
                    >
                      <div className="flex gap-(--rd-space-item)">
                        <Input
                          id={`${ids}-hwid`}
                          value={form.hwid}
                          onChange={(e) => update('hwid', e.target.value)}
                          readOnly={form.hwid_locked}
                          disabled={form.hwid_locked}
                          aria-invalid={!form.hwid.trim()}
                          className="font-mono"
                        />
                        {!form.hwid_locked && (
                          <button
                            type="button"
                            className="rd-icon-btn size-11"
                            onClick={() => update('hwid', randomHwid())}
                            aria-label="Новый идентификатор"
                            title="Новый идентификатор"
                          >
                            <IconRefresh size={20} />
                          </button>
                        )}
                      </div>
                    </FormField>

                    <div className="flex flex-col gap-(--rd-space-item)">
                      <span className="rd-body font-medium text-[var(--rd-heading)]">Что роутер сообщает провайдеру</span>
                      <dl className="flex flex-col divide-y divide-[var(--rd-divider)] rounded-[12px] bg-[var(--rd-field)] px-(--rd-space-group)">
                        <InfoRow label="User-Agent" value={XRAY_USER_AGENT} />
                        <InfoRow label="Платформа" value={XRAY_DEVICE_OS} />
                        <InfoRow label="Модель" value={device?.model || '—'} />
                        <InfoRow label="Прошивка" value={device?.os_version || '—'} />
                      </dl>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-(--rd-space-group) pb-1">
            <div className="flex items-center justify-between gap-(--rd-space-group)">
              <p className="rd-meta">
                {info
                  ? `Трафик ${formatBytesRu(used)}${info.total ? ` из ${formatBytesRu(info.total)}` : ''}`
                  : 'Список с сервера провайдера'}
                {!!info?.expire && ` · до ${new Date(info.expire * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`}
              </p>
              <button
                type="button"
                className="rd-meta rd-link-action flex shrink-0 items-center gap-(--rd-space-item) text-[var(--rd-action)] disabled:opacity-50"
                disabled={!canSubmit}
                onClick={runPreview}
              >
                {busy === 'preview' && <Spinner className="size-4" />}
                Загрузить заново
              </button>
            </div>

            {busy === 'preview' && !preview ? (
              <div className="flex justify-center py-12">
                <Spinner className="size-7 text-[var(--rd-action)]" />
              </div>
            ) : previewError ? (
              <Notice tone="error" title="Не удалось загрузить подписку" text={previewError} />
            ) : preview ? (
              <ul className="flex flex-col gap-(--rd-space-item)">
                {preview.servers.map((s) => {
                  const { main, note } = splitServerName(s.name ?? s.tag.slice(s.tag.indexOf('--') + 2))
                  return (
                    <li
                      key={s.tag}
                      className="flex min-h-12 items-center gap-(--rd-space-item) rounded-[12px] bg-[var(--rd-field)] px-(--rd-space-group)"
                    >
                      <span className="rd-body min-w-0 flex-1 truncate">
                        {main}
                        {note && <span className="ml-2 text-[var(--rd-caption)]">{note}</span>}
                      </span>
                      <span className="rd-meta shrink-0 uppercase">{s.protocol}</span>
                    </li>
                  )
                })}
                {preview.skipped.map((e) => (
                  <li
                    key={e}
                    className="rd-meta flex min-h-12 items-center rounded-[12px] bg-[var(--rd-error-bg)] px-(--rd-space-group) text-[var(--rd-error-text)]"
                  >
                    Пропущен: {e}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rd-body text-[var(--rd-caption)]">Укажите ссылку на подписку, чтобы увидеть серверы.</p>
            )}
          </div>
        )}
      </div>

      <button type="button" className="rd-btn w-full shrink-0" disabled={!canSave} onClick={save}>
        {busy === 'save' && <Spinner className="size-5" />}
        {busy === 'save' ? 'Сохраняю…' : isEdit ? 'Сохранить' : 'Добавить подписку'}
      </button>
    </div>
  )
}

// ---------- пинг и выбор сервера ----------

export interface PingResult {
  ms?: number | null
  error?: string
  loading?: boolean
}

/** TCP-пинг серверов через backend; результаты по тегу сервера. */
export function usePing() {
  const [results, setResults] = useState<Record<string, PingResult>>({})

  const ping = useCallback(async (servers: XraySubscriptionServer[]) => {
    const targets = servers.filter((s) => s.address && s.port)
    if (!targets.length) return {}
    setResults((prev) => ({ ...prev, ...Object.fromEntries(targets.map((s) => [s.tag, { ...prev[s.tag], loading: true }])) }))
    try {
      const res = await apiCall<ApiResult & { results?: Record<string, PingResult> }>('POST', 'subscriptions/ping', {
        servers: targets.map(({ tag, address, port, protocol }) => ({ tag, address, port, protocol })),
      })
      if (!res.success || !res.results) throw new Error(res.error)
      setResults((prev) => ({ ...prev, ...res.results }))
      return res.results
    } catch (e: any) {
      const failed = Object.fromEntries(targets.map((s) => [s.tag, { ms: null, error: e.message || 'ошибка проверки' }]))
      setResults((prev) => ({ ...prev, ...failed }))
      return failed as Record<string, PingResult>
    }
  }, [])

  return { results, ping }
}

/** Имя сервера для показа: из подписки как есть (с флагом), иначе — часть тега после `<подписка>--`. */
export const serverName = (sub: XraySubscription, tag: string) =>
  sub.server_list?.find((s) => s.tag === tag)?.name ?? (tag.startsWith(`${sub.tag}--`) ? tag.slice(sub.tag.length + 2) : tag)

/** Сервер, который сейчас работает под тегом подписки (как в backend `active_server`). */
export function activeServerTag(sub: XraySubscription) {
  const enabled = withoutAutoServers(sub.server_list)
  const fallback = splitRecommended(enabled).recommended[0] ?? enabled[0]
  return enabled.find((s) => s.tag === sub.primary)?.tag ?? fallback?.tag ?? ''
}
