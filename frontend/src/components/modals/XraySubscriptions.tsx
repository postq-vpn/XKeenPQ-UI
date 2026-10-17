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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconDatabase,
  IconDeviceFloppy,
  IconFilter,
  IconInfoCircle,
  IconPencil,
  IconRoute,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiCall } from '../../lib/api'
import { useAppActions } from '../../lib/store'
import type { ProxySubscriptionInfo, XraySubscription, XraySubscriptionServer } from '../../lib/types'
import { FlagPicker } from './FlagPicker'
import { ActionButton, formatDateTime, formatRelativeTime, formatTraffic, LoadingTable, ProviderBadge } from './Providers'

/** Подписка всегда запрашивается с этим User-Agent (backend: subscriptions::USER_AGENT). */
export const XRAY_USER_AGENT = 'Netcraze'

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
    hwid: randomHwid(),
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
 * Форма подписки Xray в стиле формы proxy-provider у Mihomo (AddOutbound.tsx).
 * Рендерит содержимое карточки: табы, поля и нижнюю панель; рамку задаёт родитель.
 */
export function XraySubscriptionEditor({ initial, isEdit, onSaved, initialTab = 'form' }: EditorProps) {
  const { showToast } = useAppActions()
  const [form, setForm] = useState(initial)
  const [tab, setTab] = useState<string>(initialTab)
  const device = useRouterDevice()
  const [filterEnable, setFilterEnable] = useState(() => !!(initial.filter || initial.exclude_filter || initial.exclude_type))
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)

  // Фильтры выключенного блока не отправляем, но сохраняем введённое, как у Mihomo.
  const payload = useMemo(() => (filterEnable ? form : { ...form, filter: '', exclude_filter: '', exclude_type: '' }), [form, filterEnable])

  function update<K extends keyof XraySubscription>(key: K, value: XraySubscription[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      // Теги серверов начинаются с названия подписки: переименовали — переносим отключения.
      if (key === 'tag')
        next.disabled_servers = prev.disabled_servers.map((t) =>
          t.startsWith(`${prev.tag}--`) ? `${value}--${t.slice(prev.tag.length + 2)}` : t
        )
      return next
    })
    setPreview(null)
    setPreviewError(null)
  }

  // Переключение сервера не меняет ответ подписки, поэтому предпросмотр не сбрасываем.
  function setServerEnabled(tag: string, enabled: boolean) {
    setForm((prev) => ({
      ...prev,
      disabled_servers: enabled ? prev.disabled_servers.filter((t) => t !== tag) : [...prev.disabled_servers, tag],
    }))
  }

  const isServerEnabled = (tag: string) => !form.disabled_servers.includes(tag)
  const enabledCount = preview?.servers.filter((s) => isServerEnabled(s.tag)).length ?? 0

  // «--» отделяет имя сервера в теге, в названии подписки его быть не должно.
  const tagValid = /^[A-Za-z0-9_-]{1,64}$/.test(form.tag.trim()) && !form.tag.includes('--')
  const canSubmit = !busy && tagValid && /^https?:\/\//i.test(form.url.trim()) && !!form.hwid.trim()
  const canSave = canSubmit && (!preview || enabledCount > 0)

  useEffect(() => {
    if (initialTab === 'servers') void runPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runPreview() {
    if (!canSubmit) return
    setBusy('preview')
    setPreviewError(null)
    try {
      const res = await apiCall<ApiResult & Partial<PreviewResult>>('POST', 'subscriptions/preview', payload)
      if (!res.success) throw new Error(res.error)
      setPreview({ servers: res.servers ?? [], skipped: res.skipped ?? [], userinfo: res.userinfo })
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
      const res = await apiCall<ApiResult & { subscription?: XraySubscription }>(isEdit ? 'PATCH' : 'POST', 'subscriptions', payload)
      if (!res.success || !res.subscription) throw new Error(res.error)
      showToast(`Подписка ${res.subscription.tag} ${isEdit ? 'сохранена' : 'добавлена'}: серверов ${res.subscription.servers ?? 0}`)
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
              {preview && (
                <ProviderBadge>
                  {enabledCount === preview.servers.length ? enabledCount : `${enabledCount}/${preview.servers.length}`}
                </ProviderBadge>
              )}
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
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1.5">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">Название подписки</Label>
                      <HintIcon>
                        Латиница, цифры, «-» и «_», без «--» и не совпадающее с вашими outbound (например, direct). Серверы получат теги
                        вида «название--сервер», в балансировщике достаточно указать само название.
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
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => update('hwid', randomHwid())}
                        className="size-4"
                        aria-label="Новый x-hwid"
                      >
                        <IconRefresh className="size-3" />
                      </Button>
                      <HintIcon>
                        Обязательный идентификатор устройства: без него панель не отдаст подписку. Если его поменять, роутер займёт ещё один
                        слот в лимите устройств.
                      </HintIcon>
                    </div>
                    <Input
                      value={form.hwid}
                      onChange={(e) => update('hwid', e.target.value)}
                      aria-invalid={!form.hwid.trim()}
                      placeholder="Нажмите ↻, чтобы сгенерировать"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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

            <fieldset className="border-border rounded-lg border px-4 pt-1.5 pb-4">
              <legend className="flex items-center gap-2 px-1 text-sm font-medium">
                Фильтр подключений
                <Switch
                  size="sm"
                  checked={filterEnable}
                  onCheckedChange={(v) => {
                    setFilterEnable(v)
                    setPreview(null)
                    setPreviewError(null)
                  }}
                />
              </legend>
              {filterEnable && (
                <div className="grid gap-2 pt-1">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">По названию (включить)</Label>
                    <InputGroup className="h-8">
                      <InputGroupInput
                        value={form.filter}
                        onChange={(e) => update('filter', e.target.value)}
                        placeholder="my-good-proxy"
                        className="text-xs"
                      />
                      <InputGroupAddon align="inline-end" className="gap-1 px-2 py-1 text-xs has-[>button]:mr-0">
                        <FlagPicker value={form.filter} onAdd={(next) => update('filter', next)} />
                        REGEX
                      </InputGroupAddon>
                    </InputGroup>
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">По названию (исключить)</Label>
                    <InputGroup className="h-8">
                      <InputGroupInput
                        value={form.exclude_filter}
                        onChange={(e) => update('exclude_filter', e.target.value)}
                        placeholder="my-bad-proxy"
                        className="text-xs"
                      />
                      <InputGroupAddon align="inline-end" className="gap-1 px-2 py-1 text-xs has-[>button]:mr-0">
                        <FlagPicker value={form.exclude_filter} onAdd={(next) => update('exclude_filter', next)} />
                        REGEX
                      </InputGroupAddon>
                    </InputGroup>
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">По типу (исключить)</Label>
                    <Input
                      value={form.exclude_type}
                      onChange={(e) => update('exclude_type', e.target.value)}
                      placeholder="trojan|vmess"
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
              )}
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
              <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
                <span className="flex items-center gap-1">
                  Включено {enabledCount} из {preview.servers.length}
                  <HintIcon>Отключённые серверы не попадут в конфигурацию и останутся отключёнными после обновлений подписки</HintIcon>
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={enabledCount === preview.servers.length}
                  onClick={() => setForm((prev) => ({ ...prev, disabled_servers: [] }))}
                >
                  Включить все
                </Button>
              </div>
              {preview.servers.map((s) => {
                const enabled = isServerEnabled(s.tag)
                const isLast = enabled && enabledCount === 1
                return (
                  <div
                    key={s.tag}
                    className={cn(
                      'border-border/50 hover:bg-muted/30 flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0',
                      isLast ? 'cursor-not-allowed' : 'cursor-pointer',
                      !enabled && 'opacity-50'
                    )}
                    title={isLast ? 'Должен остаться хотя бы один сервер' : undefined}
                    onClick={() => !isLast && setServerEnabled(s.tag, !enabled)}
                  >
                    <Switch
                      size="sm"
                      checked={enabled}
                      disabled={isLast}
                      aria-label={s.tag}
                      onClick={(e) => e.stopPropagation()}
                      onCheckedChange={(v) => setServerEnabled(s.tag, v)}
                    />
                    <Badge className="shrink-0 bg-blue-500/10! px-1.5 text-[10px] tracking-wider text-blue-400 uppercase">
                      {s.protocol}
                    </Badge>
                    <span className={cn('truncate font-medium', !enabled && 'line-through')}>{s.tag}</span>
                    <span className="text-muted-foreground ml-auto shrink-0 font-mono">
                      {s.address}
                      {s.port ? `:${s.port}` : ''}
                    </span>
                  </div>
                )
              })}
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

export function PingBadge({ result }: { result?: PingResult }) {
  if (!result) return null
  if (result.loading) return <Spinner className="size-3.5 shrink-0" />
  if (result.ms != null) {
    const tone = result.ms < 150 ? 'text-green-400' : result.ms < 400 ? 'text-yellow-400' : 'text-orange-400'
    return <span className={cn('shrink-0 font-mono text-xs tabular-nums', tone)}>{result.ms} мс</span>
  }
  const udp = result.error?.startsWith('UDP')
  return (
    <span className={cn('shrink-0 text-xs', udp ? 'text-muted-foreground' : 'text-red-400')} title={result.error}>
      {udp ? 'н/д' : 'нет ответа'}
    </span>
  )
}

function ProxyBadge() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="shrink-0 cursor-help rounded-full border border-green-500/40 bg-green-500/15 px-2 py-0.5 text-[11px] text-green-400" />
        }
      >
        Для прокси
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Все правила маршрутизации, которые ведут в прокси, панель автоматически направляет на эту подписку
      </TooltipContent>
    </Tooltip>
  )
}

const serverName = (sub: XraySubscription, tag: string) => (tag.startsWith(`${sub.tag}--`) ? tag.slice(sub.tag.length + 2) : tag)

/** Сервер, который сейчас работает под тегом подписки (как в backend `active_server`). */
export function activeServerTag(sub: XraySubscription) {
  const enabled = (sub.server_list ?? []).filter((s) => !s.disabled)
  return enabled.find((s) => s.tag === sub.primary)?.tag ?? enabled[0]?.tag ?? ''
}

interface PickerProps {
  sub: XraySubscription
  onDone: (sub: XraySubscription) => void
  onSkip?: () => void
}

/** Выбор сервера подписки с TCP-пингом. Если сервер ещё не выбран, предлагает самый быстрый. */
export function XrayServerPicker({ sub, onDone, onSkip }: PickerProps) {
  const { showToast } = useAppActions()
  const { results, ping } = usePing()
  const [selected, setSelected] = useState(sub.primary)
  const [saving, setSaving] = useState(false)
  const servers = useMemo(() => (sub.server_list ?? []).filter((s) => !s.disabled), [sub])
  const pinging = Object.values(results).some((r) => r.loading)

  async function runPing() {
    const res = await ping(servers)
    if (sub.primary) return
    const fastest = servers.filter((s) => res[s.tag]?.ms != null).sort((a, b) => (res[a.tag]!.ms as number) - (res[b.tag]!.ms as number))[0]
    setSelected((prev) => prev || fastest?.tag || servers[0]?.tag || '')
  }

  useEffect(() => {
    void runPing()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save() {
    setSaving(true)
    try {
      const res = await apiCall<ApiResult & { subscription?: XraySubscription }>('POST', 'subscriptions/primary', {
        tag: sub.tag,
        primary: selected,
      })
      if (!res.success || !res.subscription) throw new Error(res.error)
      showToast(`Выбран сервер ${serverName(sub, selected)}`)
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      onDone(res.subscription)
    } catch (e: any) {
      showToast(e.message || 'Не удалось сохранить', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="border-border bg-muted/30 flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
        <span>Серверов: {servers.length}</span>
        <Button variant="ghost" size="xs" disabled={pinging} onClick={() => void runPing()}>
          {pinging ? <Spinner className="size-3" /> : <IconRefresh />} Пинг
        </Button>
      </div>

      <div className="bg-input-background min-h-0 flex-1 overflow-auto">
        {servers.length === 0 && <div className="text-muted-foreground p-4 text-xs">Список серверов ещё не получен</div>}
        <RadioGroup value={selected} onValueChange={setSelected} className="gap-0">
          {servers.map((s) => (
            <div
              key={s.tag}
              className={cn(
                'border-border/50 hover:bg-muted/30 flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-[13px] last:border-b-0',
                s.tag === selected && 'bg-muted/30'
              )}
              onClick={() => setSelected(s.tag)}
            >
              <RadioGroupItem value={s.tag} aria-label={serverName(sub, s.tag)} />
              <Badge className="shrink-0 bg-blue-500/10! px-1.5 text-[10px] tracking-wider text-blue-400 uppercase">{s.protocol}</Badge>
              <span className="truncate font-medium">{serverName(sub, s.tag)}</span>
              <span className="ml-auto flex shrink-0 items-center gap-3">
                <span className="text-muted-foreground hidden font-mono text-xs sm:inline">
                  {s.address}
                  {s.port ? `:${s.port}` : ''}
                </span>
                <span className="w-16 text-right">
                  <PingBadge result={results[s.tag]} />
                </span>
              </span>
            </div>
          ))}
        </RadioGroup>
      </div>

      <p className="text-muted-foreground border-border shrink-0 border-t px-3 py-2 text-xs">
        Выбранный сервер работает под тегом <code>{sub.tag}</code>.{' '}
        {sub.proxy
          ? 'Правила маршрутизации, ведущие в прокси, панель направляет на него сама.'
          : 'Чтобы на него автоматически шли проксируемые правила маршрутизации, сделайте подписку «Для прокси».'}{' '}
        Сменить сервер можно позже на вкладке «Серверы».
      </p>

      <div className="border-border bg-muted/10 flex w-full shrink-0 gap-2 border-t p-2">
        {onSkip && (
          <Button variant="ghost" size="sm" className="text-xs" disabled={saving} onClick={onSkip}>
            Пропустить
          </Button>
        )}
        <Button variant="outline" size="sm" className="min-w-0 flex-1 gap-1.5 text-xs" disabled={saving || !selected} onClick={save}>
          {saving ? <Spinner className="size-4" /> : <IconDeviceFloppy />}
          Выбрать
        </Button>
      </div>
    </>
  )
}

interface ServerDialogProps {
  /** Подписка для выбора; null — окно закрыто. */
  sub: XraySubscription | null
  onClose: () => void
  onDone: (sub: XraySubscription) => void
}

/** Отдельное окно выбора сервера — открывается сразу после добавления подписки. */
export function XrayServerDialog({ sub, onClose, onDone }: ServerDialogProps) {
  // Держим последнюю подписку, чтобы содержимое не пропадало во время анимации закрытия.
  const [shown, setShown] = useState(sub)
  if (sub && sub !== shown) setShown(sub)

  return (
    <TooltipProvider delayDuration={500}>
      <Dialog open={sub !== null} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="flex max-h-[90dvh] w-auto! max-w-[min(90vw,720px)]! min-w-[min(90vw,480px)]! flex-col overflow-hidden">
          <DialogHeader className="shrink-0 pb-1">
            <DialogTitle className="flex items-center gap-2 pb-2">
              <IconDatabase size={22} className="text-chart-2" />
              Выберите сервер
            </DialogTitle>
            <DialogDescription>
              {shown
                ? `Подписка ${shown.tag} добавлена, серверов: ${shown.servers ?? 0}. Выберите сервер, через который пойдёт трафик`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {shown && (
            <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
              <XrayServerPicker key={shown.tag} sub={shown} onDone={onDone} onSkip={onClose} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Вызывается после изменения файлов outbounds, чтобы перечитать конфиги. */
  onChanged: () => void
  /** Открыть «Добавить подключение» (сервер или подписка). */
  onAddNew: () => void
}

type ModalTab = 'servers' | 'subscriptions'

function serversBadge(sub: XraySubscription) {
  return sub.total_servers && sub.total_servers !== sub.servers ? `${sub.servers ?? 0}/${sub.total_servers}` : (sub.servers ?? 0)
}

/** Серверы и подписки Xray; таблица подписок — в стиле «Провайдеры прокси» у Mihomo (Providers.tsx). */
export function XraySubscriptionsModal({ open, onOpenChange, onChanged, onAddNew }: ModalProps) {
  const { showToast } = useAppActions()
  const [subs, setSubs] = useState<XraySubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<ModalTab>('servers')
  const [updatingTags, setUpdatingTags] = useState<string[]>([])
  const [savingServers, setSavingServers] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<XraySubscription | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const { results: pings, ping } = usePing()

  const isUpdating = updatingTags.length > 0

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const res = await apiCall<ApiResult & { subscriptions?: XraySubscription[] }>('GET', 'subscriptions')
        if (!res.success) throw new Error(res.error)
        setSubs(res.subscriptions ?? [])
      } catch (e: any) {
        showToast(`Ошибка загрузки подписок: ${e.message}`, 'error')
      } finally {
        setLoading(false)
      }
    },
    [showToast]
  )

  useEffect(() => {
    if (!open) return
    setTab('servers')
    void load()
  }, [open, load])

  // Пинг всех серверов при заходе на вкладку «Серверы».
  useEffect(() => {
    if (open && !loading && tab === 'servers') void ping(subs.flatMap((s) => s.server_list ?? []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loading, tab, ping])

  const needle = filter.trim().toLowerCase()
  const filteredSubs = useMemo(
    () => (needle ? subs.filter((s) => s.tag.toLowerCase().includes(needle) || s.url.toLowerCase().includes(needle)) : subs),
    [subs, needle]
  )
  const serverGroups = useMemo(
    () =>
      subs
        .map((sub) => ({
          sub,
          servers: (sub.server_list ?? []).filter(
            (s) => !needle || s.tag.toLowerCase().includes(needle) || (s.address ?? '').toLowerCase().includes(needle)
          ),
        }))
        .filter((g) => !needle || g.servers.length > 0),
    [subs, needle]
  )

  const replaceSub = (next: XraySubscription) => setSubs((prev) => prev.map((s) => (s.tag === next.tag ? next : s)))

  async function selectServer(sub: XraySubscription, tag: string) {
    if (tag === activeServerTag(sub) && tag === sub.primary) return
    replaceSub({ ...sub, primary: tag })
    setSavingServers(sub.tag)
    try {
      const res = await apiCall<ApiResult & { subscription?: XraySubscription }>('POST', 'subscriptions/primary', {
        tag: sub.tag,
        primary: tag,
      })
      if (!res.success || !res.subscription) throw new Error(res.error)
      replaceSub(res.subscription)
      showToast(`Выбран сервер ${serverName(sub, tag)}`)
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      onChanged()
    } catch (e: any) {
      replaceSub(sub)
      showToast(e.message || 'Не удалось выбрать сервер', 'error')
    } finally {
      setSavingServers(null)
    }
  }

  async function setDisabledServers(sub: XraySubscription, disabled: string[]) {
    // Оптимистично: переключатель реагирует сразу, при ошибке возвращаем как было.
    replaceSub({
      ...sub,
      disabled_servers: disabled,
      server_list: sub.server_list?.map((s) => ({ ...s, disabled: disabled.includes(s.tag) })),
    })
    setSavingServers(sub.tag)
    try {
      const res = await apiCall<ApiResult & { subscription?: XraySubscription }>('POST', 'subscriptions/servers', {
        tag: sub.tag,
        disabled_servers: disabled,
      })
      if (!res.success || !res.subscription) throw new Error(res.error)
      replaceSub(res.subscription)
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      onChanged()
    } catch (e: any) {
      replaceSub(sub)
      showToast(e.message || 'Не удалось сохранить', 'error')
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

  async function makeProxy(tag: string) {
    setUpdatingTags([`proxy:${tag}`])
    try {
      const res = await apiCall<ApiResult & { subscriptions?: XraySubscription[] }>('POST', 'subscriptions/proxy', { tag })
      if (res.subscriptions) setSubs(res.subscriptions)
      if (!res.success) throw new Error(res.error)
      showToast(`Проксируемые правила маршрутизации направлены на ${tag}`)
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      onChanged()
    } catch (e: any) {
      showToast(e.message, 'error')
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

  const updatedCell = (sub: XraySubscription) =>
    sub.last_error ? (
      <Tooltip>
        <TooltipTrigger render={<span className="cursor-help text-red-400" />}>Ошибка</TooltipTrigger>
        <TooltipContent className="max-w-sm break-words">{sub.last_error}</TooltipContent>
      </Tooltip>
    ) : sub.last_update ? (
      <span title={formatDateTime(sub.last_update)}>{formatRelativeTime(sub.last_update)}</span>
    ) : (
      <span className="text-red-400">Не обновлялось</span>
    )

  const serversTab = (
    <div className="flex flex-col">
      {serverGroups.length === 0 && <div className="text-muted-foreground py-8 text-center text-[13px]">Нет совпадений</div>}
      {serverGroups.map(({ sub, servers }) => {
        const all = sub.server_list ?? []
        const enabledCount = all.filter((s) => !s.disabled).length
        const busy = savingServers === sub.tag
        const active = activeServerTag(sub)
        return (
          <div key={sub.tag}>
            <div className="border-border bg-muted/30 sticky top-0 z-10 flex items-center gap-2 border-b px-4 py-1.5 text-xs backdrop-blur-sm">
              <span className="font-medium">{sub.tag}</span>
              {sub.proxy && <ProxyBadge />}
              <ProviderBadge>{all.length ? `${enabledCount}/${all.length}` : serversBadge(sub)}</ProviderBadge>
              {sub.last_error && (
                <Tooltip>
                  <TooltipTrigger render={<span className="cursor-help text-red-400" />}>ошибка обновления</TooltipTrigger>
                  <TooltipContent className="max-w-sm break-words">{sub.last_error}</TooltipContent>
                </Tooltip>
              )}
              {busy && <Spinner className="size-3.5" />}
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="xs" disabled={all.length === 0} onClick={() => void ping(all)}>
                  <IconRefresh /> Пинг
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy || enabledCount === all.length}
                  onClick={() => void setDisabledServers(sub, [])}
                >
                  Включить все
                </Button>
              </div>
            </div>
            {all.length === 0 && (
              <div className="text-muted-foreground px-4 py-2 text-xs">
                Список серверов ещё не получен — обновите подписку на вкладке «Подписки»
              </div>
            )}
            <RadioGroup value={active} onValueChange={(tag) => void selectServer(sub, tag)} disabled={busy} className="gap-0">
              {servers.map((s) => {
                const enabled = !s.disabled
                const isActive = s.tag === active
                const isLast = enabled && enabledCount === 1
                const toggle = (next: boolean) =>
                  void setDisabledServers(sub, next ? sub.disabled_servers.filter((t) => t !== s.tag) : [...sub.disabled_servers, s.tag])
                return (
                  <div
                    key={s.tag}
                    className={cn(
                      'border-border/50 hover:bg-muted/30 flex items-center gap-3 border-b px-4 py-1.5 text-[13px] last:border-b-0',
                      enabled && !busy ? 'cursor-pointer' : 'cursor-default',
                      isActive && 'bg-muted/30',
                      !enabled && 'opacity-50'
                    )}
                    onClick={() => enabled && !busy && void selectServer(sub, s.tag)}
                  >
                    <RadioGroupItem value={s.tag} disabled={!enabled || busy} aria-label={`Выбрать ${serverName(sub, s.tag)}`} />
                    <Badge className="shrink-0 bg-blue-500/10! px-1.5 text-[10px] tracking-wider text-blue-400 uppercase">
                      {s.protocol}
                    </Badge>
                    <span className={cn('truncate font-medium', !enabled && 'line-through')}>{serverName(sub, s.tag)}</span>
                    {isActive && !sub.primary && (
                      <span
                        className="text-muted-foreground shrink-0 text-[11px]"
                        title="Сервер не выбран — используется первый включённый"
                      >
                        авто
                      </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-3">
                      <span className="text-muted-foreground hidden font-mono text-xs sm:inline">
                        {s.address}
                        {s.port ? `:${s.port}` : ''}
                      </span>
                      <span className="w-16 text-right">
                        <PingBadge result={pings[s.tag]} />
                      </span>
                      <Switch
                        size="sm"
                        checked={enabled}
                        disabled={isActive || isLast || busy}
                        aria-label={`Включить ${serverName(sub, s.tag)}`}
                        title={isActive ? 'Выбранный сервер нельзя отключить' : isLast ? 'Должен остаться хотя бы один сервер' : undefined}
                        onClick={(e) => e.stopPropagation()}
                        onCheckedChange={toggle}
                      />
                    </span>
                  </div>
                )
              })}
            </RadioGroup>
          </div>
        )
      })}
    </div>
  )

  const subscriptionsTab = (
    <Table className="min-w-100 text-[13px]! [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
      <TableHeader>
        <TableRow>
          {['Название', 'Трафик', 'Истекает', 'Обновлено'].map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
          <TableHead className="w-24 text-right">
            <ActionButton
              busy={updatingTags.length > 1}
              icon={<IconRefresh className="size-4" />}
              onClick={() => void refresh(subs.map((s) => s.tag))}
              disabled={isUpdating}
              aria-label="Обновить все"
            />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {filteredSubs.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
              Нет совпадений
            </TableCell>
          </TableRow>
        ) : (
          filteredSubs.map((sub) => (
            <TableRow key={sub.tag}>
              <TableCell className="max-w-72">
                <div className="flex items-center gap-2">
                  <div className="truncate font-medium">{sub.tag}</div>
                  {sub.proxy && <ProxyBadge />}
                  <ProviderBadge>{serversBadge(sub)}</ProviderBadge>
                </div>
              </TableCell>
              <TableCell className="min-w-42 font-medium tabular-nums">{formatTraffic(toSubscriptionInfo(sub.userinfo))}</TableCell>
              <TableCell className="tabular-nums">{formatDateTime(sub.userinfo?.expire || undefined)}</TableCell>
              <TableCell className="tabular-nums">{updatedCell(sub)}</TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-0.5">
                  {!sub.proxy && (
                    <ActionButton
                      busy={updatingTags.length === 1 && updatingTags[0] === `proxy:${sub.tag}`}
                      icon={<IconRoute className="size-4" />}
                      onClick={() => void makeProxy(sub.tag)}
                      disabled={isUpdating}
                      aria-label="Сделать подпиской для прокси"
                      title="Сделать подпиской для прокси: проксируемые правила маршрутизации перейдут на неё"
                    />
                  )}
                  <ActionButton
                    busy={false}
                    icon={<IconPencil className="size-4" />}
                    onClick={() => openEditor(sub)}
                    disabled={isUpdating}
                    aria-label="Изменить"
                  />
                  <ActionButton
                    busy={updatingTags.length === 1 && updatingTags[0] === sub.tag}
                    icon={<IconRefresh className="size-4" />}
                    onClick={() => void refresh([sub.tag], sub.tag)}
                    disabled={isUpdating}
                    aria-label="Обновить"
                  />
                  <ActionButton
                    busy={false}
                    icon={<IconTrash className="size-4" />}
                    className="hover:text-destructive hover:bg-transparent!"
                    onClick={() => setDeleting(sub.tag)}
                    disabled={isUpdating}
                    aria-label="Удалить"
                  />
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={0}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent initialFocus={false} className="w-full max-w-[95vw]! md:w-[min(80vw,850px)]">
          <div className="flex max-h-[88dvh] flex-col gap-4 overflow-hidden md:max-h-[60dvh]">
            <DialogHeader className="shrink-0">
              <DialogTitle className="flex items-center gap-2 pr-8 pb-3">
                <IconDatabase size={22} className="text-chart-2" />
                Подписки Xray
              </DialogTitle>
            </DialogHeader>

            <Tabs value={tab} onValueChange={(v) => setTab(v as ModalTab)} className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <TabsList>
                  <TabsTrigger value="servers">Серверы</TabsTrigger>
                  <TabsTrigger value="subscriptions">Подписки</TabsTrigger>
                </TabsList>
                <InputGroup className="min-w-40 flex-1">
                  <InputGroupInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Фильтр" />
                  <InputGroupAddon>
                    <IconFilter />
                  </InputGroupAddon>
                  {filter && (
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton className="text-muted-foreground hover:text-destructive" onClick={() => setFilter('')}>
                        <IconX size={13} />
                      </InputGroupButton>
                    </InputGroupAddon>
                  )}
                </InputGroup>
                <Button variant="outline" onClick={onAddNew}>
                  <IconPlus data-icon="inline-start" />
                  Добавить
                </Button>
              </div>

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
                  <>
                    <TabsContent value="servers">{serversTab}</TabsContent>
                    <TabsContent value="subscriptions">{subscriptionsTab}</TabsContent>
                  </>
                )}
              </div>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

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
              {subs.find((s) => s.tag === deleting)?.proxy
                ? subs.length > 1
                  ? 'Это подписка «Для прокси»: проксируемые правила маршрутизации перейдут на следующую подписку.'
                  : 'Это последняя подписка: правила маршрутизации, которые на неё ссылаются, останутся без сервера — поправьте их вручную.'
                : 'Правила маршрутизации, которые ссылаются на её серверы, будут направлены на подписку «Для прокси».'}
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
