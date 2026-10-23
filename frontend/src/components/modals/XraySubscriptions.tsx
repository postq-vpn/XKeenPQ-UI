import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconDatabase,
  IconDeviceFloppy,
  IconInfoCircle,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { apiCall } from '../../lib/api'
import { useAppActions } from '../../lib/store'
import type { ProxySubscriptionInfo, XraySubscription, XraySubscriptionServer } from '../../lib/types'
import { isNotRecommended, splitRecommended, withoutAutoServers } from './AutoServers'
import { ActionButton, formatDateTime, formatTraffic, LoadingTable, ProviderBadge } from './SubscriptionTableParts'

/** Подписка всегда запрашивается с этим User-Agent (backend: subscriptions::USER_AGENT). */
export const XRAY_USER_AGENT = 'Netcraze'
/** Платформа устройства (backend: subscriptions::DEVICE_OS). */
export const XRAY_DEVICE_OS = 'Router'

export const CLIENT_FINGERPRINTS = ['chrome', 'firefox', 'safari', 'iOS', 'android', 'edge', '360', 'qq', 'random']

const NUMBER_INPUT =
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none text-xs'

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

/** Название подписки для показа: от провайдера, иначе тег. */
export const subscriptionTitle = (sub: XraySubscription) => sub.title?.trim() || sub.tag

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
function useRouterDevice() {
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

const autoPlaceholder = (device: RouterDevice | null) => (device ? 'не определено' : 'определяется автоматически')

const toSubscriptionInfo = (info: XraySubscription['userinfo']): ProxySubscriptionInfo | undefined =>
  info ? { Upload: info.upload, Download: info.download, Total: info.total, Expire: info.expire } : undefined

function HintIcon({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-muted-foreground inline-flex cursor-help" />} aria-label="Подробнее">
        <IconInfoCircle size={14} />
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-xs">
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

interface EditorProps {
  initial: XraySubscription
  isEdit: boolean
  onSaved: (sub: XraySubscription) => void
  initialTab?: 'form' | 'servers'
}

/**
 * Форма подписки Xray (AddOutbound.tsx).
 * Рендерит содержимое карточки: табы, поля и нижнюю панель; рамку задаёт родитель.
 */
export function XraySubscriptionEditor({ initial, isEdit, onSaved, initialTab = 'form' }: EditorProps) {
  const { showToast } = useAppActions()
  const [form, setForm] = useState(initial)
  const [tab, setTab] = useState<string>(initialTab)
  const device = useRouterDevice()
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  // Тег новой подписки берём из её названия, пока пользователь не правил его вручную.
  const [tagTouched, setTagTouched] = useState(isEdit)

  // Фильтры выключенного блока не отправляем, но сохраняем введённое.
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
  const canSubmit = !busy && tagValid && /^https?:\/\//i.test(form.url.trim()) && !!form.hwid.trim()
  const canSave = canSubmit && (!preview || preview.servers.length > 0)

  useEffect(() => {
    // Новая подписка: сразу загружаем её, чтобы подставить название и тег.
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

  function changeTab(next: string) {
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
      showToast(
        `Подписка ${subscriptionTitle(res.subscription)} ${isEdit ? 'сохранена' : 'добавлена'}: серверов ${res.subscription.servers ?? 0}`
      )
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      onSaved(res.subscription)
    } catch (e: any) {
      showToast(e.message || 'Ошибка сохранения', 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Tabs value={tab} onValueChange={changeTab} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="border-border bg-muted/30 flex w-full shrink-0 items-center justify-between border-b px-3 py-1">
          <TabsList variant="line" className="h-8">
            <TabsTrigger value="form" className="text-sm">
              Настройки
            </TabsTrigger>
            <TabsTrigger value="servers" className="text-sm">
              Серверы
              {preview && <ProviderBadge>{preview.servers.length}</ProviderBadge>}
            </TabsTrigger>
          </TabsList>
          {tab === 'servers' && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" disabled={!canSubmit} onClick={runPreview} aria-label="Обновить список">
                    {busy === 'preview' ? <Spinner className="size-4" /> : <IconRefresh className="size-4.5" />}
                  </Button>
                }
              />
              <TooltipContent side="left">Загрузить заново</TooltipContent>
            </Tooltip>
          )}
        </div>

        <TabsContent value="form" className="min-h-0 flex-1 overflow-auto p-4">
          <div className="flex flex-col gap-4">
            <fieldset className="border-border rounded-lg border px-4 pt-1.5 pb-4">
              <legend className="px-1 text-sm font-medium">Основное</legend>
              <div className="flex flex-col gap-3 pt-1">
                <div className="grid gap-1.5">
                  <div className="flex items-center gap-1">
                    <Label className="text-xs">Название</Label>
                    <HintIcon>Берётся из подписки (заголовок profile-title), обновляется вместе с ней</HintIcon>
                  </div>
                  <div className="border-border bg-muted/30 flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs">
                    {form.title ? (
                      <span className="truncate font-medium">{form.title}</span>
                    ) : busy === 'preview' ? (
                      <>
                        <Spinner className="size-3.5" /> <span className="text-muted-foreground">Загружаю подписку...</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Провайдер не передал название</span>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1.5">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">Тег</Label>
                      {!isEdit && !tagTouched && <span className="text-muted-foreground text-[10px]">авто</span>}
                      <HintIcon>
                        Подставляется из названия подписки, можно изменить. Латиница, цифры, «-» и «_», без «--» и не совпадающий с вашими
                        outbound (например, direct). Серверы получат теги вида «тег--сервер», в балансировщике достаточно указать сам тег.
                      </HintIcon>
                    </div>
                    <Input
                      value={form.tag}
                      disabled={isEdit}
                      aria-invalid={!isEdit && !tagValid}
                      onChange={(e) => update('tag', e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">Интервал автообновления</Label>
                      <HintIcon>0 — обновлять только вручную</HintIcon>
                    </div>
                    <InputGroup className="h-8">
                      <InputGroupInput
                        type="number"
                        min={0}
                        inputMode="numeric"
                        className={NUMBER_INPUT}
                        value={form.interval}
                        onChange={(e) => update('interval', +e.target.value)}
                      />
                      <InputGroupAddon align="inline-end" className="text-muted-foreground px-2 text-xs">
                        сек
                      </InputGroupAddon>
                    </InputGroup>
                  </div>
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">URL</Label>
                  <Input
                    value={form.url}
                    onChange={(e) => update('url', e.target.value)}
                    placeholder="https://..."
                    className="h-8 text-xs"
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">Client Fingerprint</Label>
                  <Select
                    value={form.fingerprint || '__inherit__'}
                    items={{ __inherit__: 'Наследовать от провайдера', ...Object.fromEntries(CLIENT_FINGERPRINTS.map((fp) => [fp, fp])) }}
                    onValueChange={(v) => update('fingerprint', v === '__inherit__' ? '' : (v as string))}
                  >
                    <SelectTrigger size="sm" className="h-8 w-full text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="__inherit__">
                          <span className="text-xs">Наследовать от провайдера</span>
                        </SelectItem>
                        {CLIENT_FINGERPRINTS.map((fp) => (
                          <SelectItem key={fp} value={fp}>
                            <span className="text-xs">{fp}</span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </fieldset>

            <fieldset className="border-border rounded-lg border px-4 pt-1.5 pb-4">
              <legend className="flex items-center gap-2 px-1 text-sm font-medium">Заголовки</legend>
              <div className="flex flex-col gap-2 pt-1">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">User-Agent</Label>
                      <HintIcon>Фиксированное значение: подписка всегда запрашивается с User-Agent Netcraze.</HintIcon>
                    </div>
                    <Input value={XRAY_USER_AGENT} readOnly disabled className="h-8 text-xs" />
                  </div>
                  <div className="grid gap-1.5">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">
                        x-hwid<span className="text-destructive"> *</span>
                      </Label>
                      {!form.hwid_locked && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => update('hwid', randomHwid())}
                          className="size-4"
                          aria-label="Новый x-hwid"
                        >
                          <IconRefresh className="size-3" />
                        </Button>
                      )}
                      <HintIcon>
                        {form.hwid_locked
                          ? 'Привязан к роутеру: получен из его серийного номера или MAC и не меняется — ни при повторном добавлении подписки, ни при смене её ссылки. Новый слот в лимите устройств не займётся.'
                          : 'Обязательный идентификатор устройства: без него панель не отдаст подписку. Если его поменять, роутер займёт ещё один слот в лимите устройств.'}
                      </HintIcon>
                    </div>
                    <Input
                      value={form.hwid}
                      onChange={(e) => update('hwid', e.target.value)}
                      readOnly={form.hwid_locked}
                      disabled={form.hwid_locked}
                      aria-invalid={!form.hwid.trim()}
                      placeholder="Нажмите ↻, чтобы сгенерировать"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="grid gap-1.5">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">x-device-os</Label>
                      <HintIcon>Платформа устройства, для роутера всегда Router.</HintIcon>
                    </div>
                    <Input value={XRAY_DEVICE_OS} readOnly disabled className="h-8 text-xs" />
                  </div>
                  <div className="grid gap-1.5">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">x-device-model</Label>
                      <HintIcon>Модель роутера, определяется автоматически.</HintIcon>
                    </div>
                    <Input value={device?.model ?? ''} placeholder={autoPlaceholder(device)} readOnly disabled className="h-8 text-xs" />
                  </div>
                  <div className="grid gap-1.5">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">x-ver-os</Label>
                      <HintIcon>Версия ОС роутера, определяется автоматически и обновляется сама после обновления прошивки.</HintIcon>
                    </div>
                    <Input
                      value={device?.os_version ?? ''}
                      placeholder={autoPlaceholder(device)}
                      readOnly
                      disabled
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
              </div>
            </fieldset>
          </div>
        </TabsContent>

        <TabsContent value="servers" className="bg-input-background min-h-0 flex-1 overflow-auto">
          {busy === 'preview' && !preview ? (
            <div className="flex justify-center p-10">
              <Spinner className="size-6" />
            </div>
          ) : previewError ? (
            <div className="text-destructive p-4 text-xs break-words">{previewError}</div>
          ) : preview ? (
            <>
              <div className="border-border text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
                <span>Трафик: {formatTraffic(toSubscriptionInfo(preview.userinfo))}</span>
                {!!preview.userinfo?.expire && <span>Истекает: {formatDateTime(preview.userinfo.expire)}</span>}
              </div>
              {preview.servers.map((s) => (
                <div key={s.tag} className="border-border/50 flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0">
                  <span className="truncate font-medium">{s.name ?? s.tag.slice(s.tag.indexOf('--') + 2)}</span>
                </div>
              ))}
              {preview.skipped.map((e) => (
                <div
                  key={e}
                  className="border-border/50 text-destructive border-b px-3 py-1.5 text-xs last:border-b-0"
                  title="Сервер пропущен"
                >
                  {e}
                </div>
              ))}
            </>
          ) : (
            <div className="text-muted-foreground p-4 text-xs">Укажите название и URL подписки</div>
          )}
        </TabsContent>
      </Tabs>

      <div className="border-border bg-muted/10 flex w-full shrink-0 gap-2 border-t p-2">
        <Button
          variant="outline"
          size="sm"
          className="min-w-0 flex-1 shrink gap-1.5 px-1.5 text-xs sm:px-2.5"
          disabled={!canSave}
          onClick={save}
        >
          {busy === 'save' ? <Spinner className="size-4" /> : isEdit ? <IconDeviceFloppy /> : <IconPlus />}
          <span className="truncate">{isEdit ? 'Сохранить' : 'Добавить подписку'}</span>
        </Button>
      </div>
    </>
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

const DAY_MS = 86_400_000
/** За сколько дней до окончания подписки предупреждать о продлении. */
const EXPIRY_WARN_DAYS = 5

function pluralDays(n: number) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'день'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня'
  return 'дней'
}

/** «До конца подписки: N дней»; за 5 дней и меньше — оранжевый значок с напоминанием продлить. */
function SubscriptionExpiry({ expire }: { expire: number }) {
  const days = Math.ceil((expire * 1000 - Date.now()) / DAY_MS)
  const expired = days <= 0
  const text = expired ? 'Подписка закончилась' : `До конца подписки: ${days} ${pluralDays(days)}`
  if (days > EXPIRY_WARN_DAYS) return <span className="text-muted-foreground tabular-nums">{text}</span>

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={100}
        render={<button type="button" className="flex cursor-help items-center gap-1.5 text-orange-400 tabular-nums" />}
      >
        <IconAlertCircle className="size-4 shrink-0" />
        {text}
      </PopoverTrigger>
      <PopoverContent side="bottom" className="w-64 text-xs">
        {expired
          ? 'Срок подписки истёк — серверы перестанут работать. Продлите подписку, затем обновите её здесь.'
          : `Подписка закончится ${formatDateTime(expire)}. Продлите её, чтобы VPN не отключился.`}
      </PopoverContent>
    </Popover>
  )
}

/** Плашка на всю ширину перед российскими серверами в конце списка (см. `isNotRecommended`). */
function NotRecommendedLabel() {
  return (
    <div className="flex w-full items-center gap-2 border-y border-orange-500/25 bg-orange-500/10 px-4 py-1.5 text-xs font-medium text-orange-700 dark:text-orange-400">
      <IconAlertTriangle className="size-3.5 shrink-0" />
      Не рекомендуется — медленнее остальных
    </div>
  )
}

/** Значение пункта «Авто» в списках серверов; на backend это пустой `primary`. */
const AUTO_SERVER = '__auto__'

/** Как часто спрашивать у Xray, какой сервер выбран в режиме «Авто». */
const CURRENT_POLL_MS = 15000

/**
 * Пункт «Авто»: Xray сам ведёт трафик через самый быстрый рабочий сервер (backend balancer.rs).
 * `current` — имя сервера, выбранного сейчас (если Xray его сообщил), `ping` — его пинг.
 */
function AutoServerRow(props: {
  selected: boolean
  disabled?: boolean
  className: string
  current?: string
  ping?: PingResult
  onSelect: () => void
}) {
  const { selected, disabled, className, current, ping, onSelect } = props
  return (
    <div
      className={cn(
        'border-border/50 hover:bg-muted/30 flex items-center gap-3 border-b text-[13px]',
        disabled ? 'cursor-default' : 'cursor-pointer',
        selected && 'bg-muted/30',
        className
      )}
      onClick={() => !disabled && onSelect()}
    >
      <RadioGroupItem value={AUTO_SERVER} disabled={disabled} aria-label="Авто" />
      <span className="shrink-0 font-medium">⚡ Авто</span>
      <span className="text-muted-foreground truncate text-[11px]">{current ? `сейчас: ${current}` : 'самый быстрый рабочий сервер'}</span>
      <span className="ml-auto w-16 shrink-0 text-right">
        <PingBadge result={ping} />
      </span>
    </div>
  )
}

export function PingBadge({ result }: { result?: PingResult }) {
  if (!result) return null
  if (result.loading) return <Spinner className="size-3.5 shrink-0" />
  if (result.ms != null) {
    // Пинг — реальный запрос через сервер (см. backend ping.rs), поэтому пороги выше, чем у TCP.
    const tone = result.ms < 400 ? 'text-green-400' : result.ms < 800 ? 'text-yellow-400' : 'text-orange-400'
    return <span className={cn('shrink-0 font-mono text-xs tabular-nums', tone)}>{result.ms} мс</span>
  }
  const udp = result.error?.startsWith('UDP')
  return (
    <span className={cn('shrink-0 text-xs', udp ? 'text-muted-foreground' : 'text-red-400')} title={result.error}>
      {udp ? 'н/д' : 'нет ответа'}
    </span>
  )
}

/** Имя сервера для показа: из подписки как есть (с флагом), иначе — часть тега после `<подписка>--`. */
export const serverName = (sub: XraySubscription, tag: string) =>
  sub.server_list?.find((s) => s.tag === tag)?.name ?? (tag.startsWith(`${sub.tag}--`) ? tag.slice(sub.tag.length + 2) : tag)

/** Сервер, который сейчас работает под тегом подписки (как в backend `active_server`). */
export function activeServerTag(sub: XraySubscription) {
  const enabled = withoutAutoServers(sub.server_list)
  return enabled.find((s) => s.tag === sub.primary)?.tag ?? enabled[0]?.tag ?? ''
}

interface ModalProps {
  /** Меняется, когда подписки изменились снаружи (добавлена новая) — список перечитывается. */
  reloadKey?: number
  /** Элементы справа в заголовке блока. */
  headerExtra?: ReactNode
  /** Список подписок загружен — родитель решает, показать ли окно первого запуска. */
  onLoaded?: (subs: XraySubscription[]) => void
  /** Вызывается после изменения файлов outbounds, чтобы перечитать конфиги. */
  onChanged: () => void
  /** Открыть «Добавить подключение» (сервер или подписка). */
  onAddNew: () => void
}

/** Главная страница: подписки Xray и их серверы. */
export function XraySubscriptionsModal({ onChanged, onAddNew, reloadKey, headerExtra, onLoaded }: ModalProps) {
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded
  const { showToast } = useAppActions()
  const [subs, setSubs] = useState<XraySubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [updatingTags, setUpdatingTags] = useState<string[]>([])
  const [savingServers, setSavingServers] = useState<string | null>(null)
  const [editing, setEditing] = useState<XraySubscription | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const { results: pings, ping } = usePing()
  /** Сервер, выбранный балансировщиком сейчас: тег подписки → тег сервера. */
  const [current, setCurrent] = useState<Record<string, string>>({})

  const isUpdating = updatingTags.length > 0

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const res = await apiCall<ApiResult & { subscriptions?: XraySubscription[] }>('GET', 'subscriptions')
        if (!res.success) throw new Error(res.error)
        setSubs(res.subscriptions ?? [])
        onLoadedRef.current?.(res.subscriptions ?? [])
      } catch (e: any) {
        showToast(`Ошибка загрузки подписок: ${e.message}`, 'error')
      } finally {
        setLoading(false)
      }
    },
    [showToast]
  )

  // Первая загрузка — со скелетоном, перечитывание после изменений снаружи — тихое.
  useEffect(() => {
    void load(reloadKey !== undefined && reloadKey > 0)
  }, [load, reloadKey])

  // В режиме «Авто» сервер меняет сам Xray — периодически спрашиваем, какой выбран.
  const hasAuto = subs.some((s) => !s.primary)
  useEffect(() => {
    if (!hasAuto) {
      setCurrent({})
      return
    }
    let stopped = false
    const poll = async () => {
      try {
        const res = await apiCall<ApiResult & { current?: Record<string, string> }>('GET', 'subscriptions/current')
        if (!stopped && res.success) setCurrent(res.current ?? {})
      } catch {
        // Не критично: подпись останется общей.
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), CURRENT_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [hasAuto, subs])

  // Пинг всех серверов после загрузки списка и когда серверы поменялись (например, добавили подписку).
  const serverTags = subs.flatMap((s) => withoutAutoServers(s.server_list).map((x) => x.tag)).join('\n')
  useEffect(() => {
    if (!loading && serverTags) void ping(subs.flatMap((s) => withoutAutoServers(s.server_list)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, serverTags, ping])

  const serverGroups = useMemo(
    () =>
      subs.map((sub) => {
        // Российские серверы — в конце, под плашкой «Не рекомендуется».
        const { recommended, notRecommended } = splitRecommended(withoutAutoServers(sub.server_list))
        return { sub, servers: [...recommended, ...notRecommended] }
      }),
    [subs]
  )

  const replaceSub = (next: XraySubscription) => setSubs((prev) => prev.map((s) => (s.tag === next.tag ? next : s)))

  async function selectServer(sub: XraySubscription, tag: string) {
    if (tag === sub.primary) return
    replaceSub({ ...sub, primary: tag })
    setSavingServers(sub.tag)
    try {
      const res = await apiCall<ApiResult & { subscription?: XraySubscription }>('POST', 'subscriptions/primary', {
        tag: sub.tag,
        primary: tag,
      })
      if (!res.success || !res.subscription) throw new Error(res.error)
      replaceSub(res.subscription)
      showToast(tag ? `Выбран сервер ${serverName(sub, tag)}` : 'Сервер выбирается автоматически')
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      onChanged()
    } catch (e: any) {
      replaceSub(sub)
      showToast(e.message || 'Не удалось выбрать сервер', 'error')
    } finally {
      setSavingServers(null)
    }
  }

  async function refresh(tags: string[], tag?: string) {
    setUpdatingTags(tags)
    try {
      const res = await apiCall<ApiResult & { changed?: boolean; subscriptions?: XraySubscription[] }>('POST', 'subscriptions/refresh', {
        tag,
      })
      if (res.subscriptions) setSubs(res.subscriptions)
      if (!res.success) throw new Error(res.error)
      showToast(tag ? `Подписка ${tag} обновлена` : 'Подписки обновлены')
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      if (res.changed) onChanged()
    } catch (e: any) {
      showToast(`Ошибка обновления: ${e.message}`, 'error')
    } finally {
      setUpdatingTags([])
    }
  }

  async function remove(tag: string) {
    setDeleting(null)
    setUpdatingTags([tag])
    try {
      const res = await apiCall<ApiResult>('DELETE', `subscriptions?tag=${encodeURIComponent(tag)}`)
      if (!res.success) throw new Error(res.error)
      showToast(`Подписка ${tag} удалена`)
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      setSubs((prev) => prev.filter((s) => s.tag !== tag))
      onChanged()
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      setUpdatingTags([])
    }
  }

  function openEditor(sub: XraySubscription) {
    setEditing(sub)
    setEditorOpen(true)
  }

  function onSaved() {
    setEditorOpen(false)
    void load(true)
    onChanged()
  }

  const serversTab = (
    <div className="flex flex-col">
      {serverGroups.length === 0 && <div className="text-muted-foreground py-8 text-center text-[13px]">Нет совпадений</div>}
      {serverGroups.map(({ sub, servers }) => {
        const all = withoutAutoServers(sub.server_list)
        const busy = savingServers === sub.tag
        const active = activeServerTag(sub)
        return (
          <div key={sub.tag}>
            <div className="border-border bg-muted/30 sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center sm:grid-cols-[1fr_auto_1fr] gap-2 border-b px-4 py-1.5 text-xs backdrop-blur-sm">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                <div className="flex min-w-0 items-center gap-1">
                  <span className="mr-1 truncate font-medium">{subscriptionTitle(sub)}</span>
                  <ActionButton
                    busy={updatingTags.includes(sub.tag)}
                    icon={<IconRefresh className="size-4" />}
                    onClick={() => void refresh([sub.tag], sub.tag)}
                    disabled={isUpdating}
                    aria-label="Обновить подписку"
                    title="Обновить подписку"
                  />
                  <ActionButton
                    busy={false}
                    icon={<IconPencil className="size-4" />}
                    onClick={() => openEditor(sub)}
                    disabled={isUpdating}
                    aria-label="Изменить подписку"
                    title="Изменить подписку"
                  />
                  <ActionButton
                    busy={false}
                    icon={<IconTrash className="size-4" />}
                    className="hover:text-destructive hover:bg-transparent!"
                    onClick={() => setDeleting(sub.tag)}
                    disabled={isUpdating}
                    aria-label="Удалить подписку"
                    title="Удалить подписку"
                  />
                </div>
                {sub.last_error && (
                  <Tooltip>
                    <TooltipTrigger render={<span className="cursor-help text-red-400" />}>ошибка обновления</TooltipTrigger>
                    <TooltipContent className="max-w-sm break-words">{sub.last_error}</TooltipContent>
                  </Tooltip>
                )}
                {busy && <Spinner className="size-3.5" />}
              </div>
              <div className="flex justify-center">{!!sub.userinfo?.expire && <SubscriptionExpiry expire={sub.userinfo.expire} />}</div>
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0 justify-self-end"
                disabled={all.length === 0}
                onClick={() => void ping(all)}
              >
                <IconRefresh /> Пинг
              </Button>
            </div>
            {all.length === 0 && (
              <div className="text-muted-foreground px-4 py-2 text-xs">Список серверов ещё не получен — обновите подписку</div>
            )}
            <RadioGroup
              value={sub.primary ? active : AUTO_SERVER}
              onValueChange={(tag) => void selectServer(sub, tag === AUTO_SERVER ? '' : tag)}
              disabled={busy}
              className="gap-0"
            >
              {all.length > 0 && (
                <AutoServerRow
                  selected={!sub.primary}
                  disabled={busy}
                  className="px-4 py-1.5"
                  current={!sub.primary && current[sub.tag] ? serverName(sub, current[sub.tag]) : undefined}
                  ping={!sub.primary && current[sub.tag] ? pings[current[sub.tag]] : undefined}
                  onSelect={() => void selectServer(sub, '')}
                />
              )}
              {servers.map((s, i) => {
                const isActive = !!sub.primary && s.tag === active
                const firstNotRecommended = isNotRecommended(s) && (i === 0 || !isNotRecommended(servers[i - 1]))
                return (
                  <Fragment key={s.tag}>
                    {firstNotRecommended && <NotRecommendedLabel />}
                    <div
                      className={cn(
                        'border-border/50 hover:bg-muted/30 flex items-center gap-3 border-b px-4 py-1.5 text-[13px] last:border-b-0',
                        busy ? 'cursor-default' : 'cursor-pointer',
                        isActive && 'bg-muted/30'
                      )}
                      onClick={() => !busy && void selectServer(sub, s.tag)}
                    >
                      <RadioGroupItem value={s.tag} disabled={busy} aria-label={`Выбрать ${serverName(sub, s.tag)}`} />
                      <span className="truncate font-medium">{serverName(sub, s.tag)}</span>
                      <span className="ml-auto w-16 shrink-0 text-right">
                        <PingBadge result={pings[s.tag]} />
                      </span>
                    </div>
                  </Fragment>
                )
              })}
            </RadioGroup>
          </div>
        )
      })}
    </div>
  )

  const body = (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="border-border bg-input-background min-h-0 flex-1 scrollbar-thin overflow-auto rounded-xl border">
        {loading ? (
          <LoadingTable />
        ) : subs.length === 0 ? (
          <Empty className="min-h-90 border-none">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IconDatabase className="size-8" />
              </EmptyMedia>
              <EmptyTitle className="text-[16px] tracking-normal">Подписок пока нет</EmptyTitle>
              <EmptyDescription>Добавьте сервер или ссылку на подписку — серверы подписки будут обновляться сами</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="ghost" size="sm" onClick={onAddNew}>
                <IconPlus data-icon="inline-start" className="size-4" />
                Добавить
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          serversTab
        )}
      </div>
    </div>
  )

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={0}>
      <section className="border-border bg-card flex flex-col gap-4 rounded-xl border px-3 py-3 sm:px-4 sm:py-4">
        <div className="flex items-center gap-1.5 sm:gap-2">
          <h2 className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold select-none sm:gap-2 sm:text-lg">
            <IconDatabase className="text-chart-2 size-4.5 shrink-0 sm:size-5" />
            <span className="truncate">Подписка и серверы</span>
          </h2>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onAddNew}
            aria-label="Добавить подписку или сервер"
            title="Добавить подписку или сервер"
            className="shrink-0 max-sm:size-6 max-sm:[&_svg]:size-3.5"
          >
            <IconPlus />
          </Button>
          <div className="ml-auto flex shrink-0 items-center gap-2">{headerExtra}</div>
        </div>
        <div className="flex max-h-[70dvh] min-h-0 flex-col">{body}</div>
      </section>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="flex max-h-[90dvh] w-auto! max-w-[min(90vw,900px)]! min-w-[min(90vw,480px)]! flex-col overflow-hidden">
          <DialogHeader className="shrink-0 pb-1">
            <DialogTitle className="flex items-center gap-2 pb-2">
              <IconPencil size={22} className="text-chart-2" />
              {editing?.tag}
            </DialogTitle>
            <DialogDescription>Серверы из подписки записываются в отдельный файл и обновляются автоматически</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
              <XraySubscriptionEditor key={editing.tag} initial={editing} isEdit onSaved={onSaved} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить подписку {deleting}?</AlertDialogTitle>
            <AlertDialogDescription>
              Файл с её серверами будет удалён, Xray перезапустится.{' '}
              {subs.length === 1 &&
                'Это последняя подписка: правила маршрутизации, которые на неё ссылаются, останутся без сервера — поправьте их вручную.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleting(null)}>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && void remove(deleting)}>
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
