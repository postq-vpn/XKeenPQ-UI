import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { RuExcludeSetting } from './RuExcludeSetting'
import { useTechMenuUnlocked } from '../../lib/techMenu'
import { X as IconX, Undo2 as IconArrowBackUp } from 'lucide-react'
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { apiCall } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import { XRAY_LOG_LEVELS, type AppSettings, type ThemeMode, type XrayLogLevel } from '../../lib/types'

type BooleanSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never
}[keyof AppSettings]

type ToggleSetting = {
  id: string
  key: BooleanSettingKey
  path: string
  title: string
  description: string
}

type ToggleSettingHandler = (item: ToggleSetting, value: boolean) => void

const guiSettings: ToggleSetting[] = [
  {
    id: 'gui-routing',
    key: 'guiRouting',
    path: 'gui.routing',
    title: 'Routing',
    description: 'Визуализация правил роутинга для Xray',
  },
  {
    id: 'gui-log',
    key: 'guiLog',
    path: 'gui.log',
    title: 'Log',
    description: 'Визуализация настроек логирования для Xray',
  },
  {
    id: 'auto-apply',
    key: 'autoApply',
    path: 'gui.auto_apply',
    title: 'Автоприменение',
    description: 'Автоматически применять следующие изменения в режиме GUI:\n • Routing: изменение outboundTag\n • Log: любые изменения',
  },
]

const updateSettings: ToggleSetting[] = [
  {
    id: 'auto-ui',
    key: 'autoCheckUI',
    path: 'updater.auto_check_ui',
    title: 'Автопроверка (панель)',
    description: 'Фоновая проверка обновлений панели с интервалом в 4 часа',
  },
  {
    id: 'auto-core',
    key: 'autoCheckCore',
    path: 'updater.auto_check_core',
    title: 'Автопроверка (ядро)',
    description: 'Фоновая проверка обновлений ядра с интервалом в 4 часа',
  },
  {
    id: 'backup',
    key: 'backupCore',
    path: 'updater.backup_core',
    title: 'Бэкап ядра',
    description: 'Сохранять резервную копию ядра при обновлении',
  },
]

const pluginSettings: ToggleSetting[] = [
  {
    id: 'multi-router',
    key: 'multiRouter',
    path: 'plugins.multi_router',
    title: 'Несколько роутеров',
    description: 'Сохранение, применение и бэкап конфигов на выбранные роутеры',
  },
]

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'auto', label: 'Как в системе' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
]

const SwitchSettingField = memo(function SwitchSettingField({
  item,
  checked,
  onToggleSetting,
}: {
  item: ToggleSetting
  checked: boolean
  onToggleSetting: ToggleSettingHandler
}) {
  const onToggle = useCallback((value: boolean) => onToggleSetting(item, value), [item, onToggleSetting])

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={item.id}>{item.title}</FieldLabel>
        <FieldDescription className="whitespace-pre-line">{item.description}</FieldDescription>
      </FieldContent>
      <Switch id={item.id} checked={checked} onCheckedChange={onToggle} aria-label={item.title} />
    </Field>
  )
})

const ProxyRow = memo(function ProxyRow({
  proxy,
  index,
  onRemove,
}: {
  proxy: string
  index: number
  onRemove: (index: number) => Promise<void>
}) {
  const onRemoveClick = useCallback(() => void onRemove(index), [index, onRemove])

  return (
    <div className="flex items-center gap-2">
      <div className="flex h-11 min-w-0 flex-1 items-center rounded-[12px] bg-[var(--rd-surface)] px-3.5">
        <span className="w-full truncate text-[14px]">{proxy}</span>
      </div>
      <Button variant="destructive" className="shrink-0" onClick={onRemoveClick} aria-label={`Удалить прокси ${proxy}`}>
        Удалить
      </Button>
    </div>
  )
})

const ProxySettingsField = memo(function ProxySettingsField({
  githubProxies,
  onAddProxy,
  onRemoveProxy,
}: {
  githubProxies: string[]
  onAddProxy: (url: string) => Promise<boolean>
  onRemoveProxy: (index: number) => Promise<void>
}) {
  const [newProxy, setNewProxy] = useState('')
  const hasNewProxy = newProxy.trim().length > 0

  const addProxy = useCallback(async () => {
    if (!hasNewProxy) return
    const ok = await onAddProxy(newProxy)
    if (ok) setNewProxy('')
  }, [hasNewProxy, newProxy, onAddProxy])

  return (
    <Field>
      <FieldContent>
        <FieldLabel htmlFor="github-proxy-input">GitHub Proxy</FieldLabel>
        <FieldDescription className="text-wrap!">
          Прокси для загрузки обновлений при отсутствии доступа к GitHub, используются по порядку сверху вниз
        </FieldDescription>
      </FieldContent>

      {githubProxies.length === 0 ? (
        <FieldDescription>Прокси не добавлены</FieldDescription>
      ) : (
        <div className="flex flex-col gap-3">
          {githubProxies.map((proxy, index) => (
            <ProxyRow key={proxy + index} proxy={proxy} index={index} onRemove={onRemoveProxy} />
          ))}
        </div>
      )}

      <Field orientation="horizontal" className="gap-2">
        <InputGroup className="flex-1">
          <InputGroupInput
            id="github-proxy-input"
            value={newProxy}
            onChange={(e) => setNewProxy(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addProxy()}
            placeholder="Введите URL прокси..."
            className={hasNewProxy ? 'pr-7' : undefined}
          />
          <InputGroupAddon align="inline-end">
            {hasNewProxy && (
              <InputGroupButton
                aria-label="Очистить поле"
                className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
                onClick={() => setNewProxy('')}
              >
                <IconX />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        <Button variant="default" className="shrink-0" onClick={() => void addProxy()} disabled={!hasNewProxy}>
          Добавить
        </Button>
      </Field>
    </Field>
  )
})

type RepoSourceKey = 'xrayRepo'

const GITHUB_REPO_PREFIX = 'https://github.com/'

function normalizeGitHubRepoUrl(raw: string): string | null {
  let url = raw.trim().replace(/\/+$/, '')
  if (!url) return null
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  url = url.replace(/^http:\/\/github\.com\//i, GITHUB_REPO_PREFIX)
  const match = url.match(/^https:\/\/github\.com\/([^/\s?#]+)\/([^/\s?#]+)(?:[/?#].*)?$/i)
  if (!match) return null
  const owner = match[1]
  let repo = match[2].replace(/\.git$/i, '')
  if (!owner || !repo) return null
  return `${GITHUB_REPO_PREFIX}${owner}/${repo}`
}

const RepoSourceField = memo(function RepoSourceField({
  repoKey,
  label,
  description,
  value,
  onSave,
  showToast,
}: {
  repoKey: RepoSourceKey
  label: string
  description: string
  value: string
  onSave: (key: RepoSourceKey, url: string) => Promise<boolean>
  showToast: (msg: string, type?: 'success' | 'error') => void
}) {
  const [draft, setDraft] = useState(value)

  const defaultUrl = 'https://github.com/XTLS/Xray-core'

  const invalid = normalizeGitHubRepoUrl(draft) === null

  const save = useCallback(
    async (overrideUrl?: string) => {
      const raw = (typeof overrideUrl === 'string' ? overrideUrl : draft).trim().replace(/\/+$/, '')
      if (!raw) {
        showToast('URL репозитория не может быть пустым', 'error')
        return
      }
      const url = normalizeGitHubRepoUrl(raw)
      if (!url) {
        showToast('Некорректный URL', 'error')
        return
      }
      if (url === value) {
        setDraft(url)
        return
      }
      if (await onSave(repoKey, url)) setDraft(url)
    },
    [draft, onSave, repoKey, showToast, value]
  )

  return (
    <Field>
      <FieldContent>
        <FieldLabel htmlFor={`${repoKey}-input`}>{label}</FieldLabel>
        <FieldDescription className="text-wrap!">{description}</FieldDescription>
      </FieldContent>
      <Field orientation="horizontal" className="gap-2">
        <InputGroup className="flex-1">
          <InputGroupInput
            id={`${repoKey}-input`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            onBlur={() => void save()}
            placeholder={defaultUrl}
            aria-invalid={invalid}
            className="text-sm placeholder:text-sm"
          />
          {draft !== defaultUrl && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label="Вернуть значение по-умолчанию"
                title="Вернуть значение по-умолчанию"
                className="text-muted-foreground hover:text-foreground hover:bg-transparent!"
                onMouseDown={(e) => e.preventDefault()} // Блочим лишний onBlur инпута
                onClick={() => void save(defaultUrl)}
              >
                <IconArrowBackUp className="size-4.5" />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </Field>
      {invalid && <FieldError>Некорректный URL</FieldError>}
    </Field>
  )
})

function AuthSettingsField({
  authEnabled,
  onToggle,
  showToast,
}: {
  authEnabled: boolean
  onToggle: (value: boolean) => Promise<void>
  showToast: (msg: string, type?: 'success' | 'error') => void
}) {
  const [resetOpen, setResetOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')

  const resetPassword = useCallback(async () => {
    const res = await fetch('/api/auth/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: currentPassword }),
    })
    const data = await res.json()
    if (data.success) window.location.reload()
    else showToast(data.error ?? 'Ошибка', 'error')
  }, [currentPassword, showToast])

  return (
    <FieldGroup className="gap-0!">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel>Пароль для входа</FieldLabel>
          <FieldDescription>Панель спросит пароль при открытии</FieldDescription>
        </FieldContent>
        <Switch checked={authEnabled} onCheckedChange={onToggle} aria-label="Авторизация" />
      </Field>

      {authEnabled && (
        <>
          <Separator className="my-0" />
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Сменить пароль</FieldLabel>
              <FieldDescription>Сбросить текущий и задать новый</FieldDescription>
            </FieldContent>
            <Popover open={resetOpen} onOpenChange={setResetOpen}>
              <PopoverTrigger
                render={
                  <Button variant="destructive" size="sm">
                    Сбросить
                  </Button>
                }
              />
              <PopoverContent>
                <PopoverHeader>
                  <PopoverTitle>Введите текущий пароль. Новый пароль можно задать только из локальной сети</PopoverTitle>
                </PopoverHeader>
                <Input
                  type="password"
                  placeholder="Текущий пароль"
                  aria-label="Текущий пароль"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setResetOpen(false)}>
                    Нет
                  </Button>
                  <Button size="sm" variant="destructive" disabled={!currentPassword} onClick={() => void resetPassword()}>
                    Да
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </Field>
        </>
      )}
    </FieldGroup>
  )
}

/** Группа настроек: подпись сверху, строки на серой подложке (globals.css, .rd-settings-group). */
function SettingsGroup({ title, notice, children }: { title: string; notice?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-(--rd-space-item)">
      <div className="flex flex-col gap-(--rd-space-title) px-1">
        <h3 className="rd-meta">{title}</h3>
        {notice && <p className="text-[13px] leading-[18px] text-[var(--rd-warn-text)]">{notice}</p>}
      </div>
      <div className="rd-settings-group">{children}</div>
    </section>
  )
}

interface SettingsModalProps {
  /** Открыть журнал из «Технического меню». */
  onOpenLog: () => void
  /** Открыть конфиг Xray или список XKeen из «Технического меню». */
  onOpenFile: (file: string) => void
}

export function SettingsModal({ onOpenLog }: SettingsModalProps) {
  const { state, dispatch, showToast } = useAppContext({ includeSettings: true })
  const { modals } = useModalContext()
  const { settings } = state
  const techMenu = useTechMenuUnlocked()
  const [tab, setTab] = useState('general')
  // Меню скрыли, пока была открыта его вкладка, — возвращаемся на «Общие».
  useEffect(() => {
    if (!techMenu && tab === 'tech') setTab('general')
  }, [techMenu, tab])

  const close = useCallback(() => dispatch({ type: 'SHOW_MODAL', modal: 'showSettingsModal', show: false }), [dispatch])

  const saveSetting = useCallback(
    async (path: string, value: unknown) => {
      const [section, key] = path.split('.')
      try {
        const body: Record<string, unknown> = {}
        if (['gui', 'updater', 'log', 'auth', 'plugins'].includes(section)) body[section] = key ? { [key]: value } : value
        const result = await apiCall<any>('PATCH', 'settings', body)
        if (!result.success) {
          showToast('Ошибка: ' + result.error, 'error')
          return false
        }
        return true
      } catch (e: any) {
        showToast(e.message, 'error')
        return false
      }
    },
    [showToast]
  )

  const toggleSetting = useCallback(
    async (item: ToggleSetting, value: boolean) => {
      const ok = await saveSetting(item.path, value)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { [item.key]: value } as Partial<AppSettings> })
    },
    [dispatch, saveSetting]
  )

  const setTheme = useCallback(
    (value: string) => {
      dispatch({ type: 'SET_SETTINGS', settings: { theme: value as ThemeMode } })
    },
    [dispatch]
  )

  const toggleAuth = useCallback(
    async (value: boolean) => {
      const ok = await saveSetting('auth.enabled', value)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { authEnabled: value } })
    },
    [dispatch, saveSetting]
  )

  const addProxy = useCallback(
    async (rawUrl: string) => {
      let url = rawUrl.trim().replace(/\/+$/, '')
      if (!url) return false
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url
      if (settings.githubProxies.includes(url)) {
        showToast('Уже добавлен', 'error')
        return false
      }
      const next = [...settings.githubProxies, url]
      const ok = await saveSetting('updater.github_proxy', next)
      if (ok) {
        dispatch({ type: 'SET_SETTINGS', settings: { githubProxies: next } })
        return true
      }
      return false
    },
    [dispatch, saveSetting, settings.githubProxies, showToast]
  )

  const removeProxy = useCallback(
    async (index: number) => {
      const next = settings.githubProxies.filter((_, i) => i !== index)
      const ok = await saveSetting('updater.github_proxy', next)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { githubProxies: next } })
    },
    [dispatch, saveSetting, settings.githubProxies]
  )

  const saveRepoSource = useCallback(
    async (key: RepoSourceKey, url: string) => {
      const ok = await saveSetting('updater.xray_repo', url)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { [key]: url } })
      return ok
    },
    [dispatch, saveSetting]
  )

  const setXrayLogLevel = useCallback(
    async (value: string) => {
      const ok = await saveSetting('log.xray_level', value)
      if (ok) {
        dispatch({ type: 'SET_SETTINGS', settings: { xrayLogLevel: value as XrayLogLevel } })
        showToast(`Уровень логов Xray: ${value}`)
      }
    },
    [dispatch, saveSetting, showToast]
  )

  const setTimezone = useCallback(
    async (value: string) => {
      const offset = parseInt(value, 10)
      const ok = await saveSetting('log.timezone', offset)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { timezone: offset } })
    },
    [dispatch, saveSetting]
  )

  const timezoneItems = Object.fromEntries(
    Array.from({ length: 27 }, (_, i) => {
      const v = String(i - 12)
      return [v, `UTC${i - 12 >= 0 ? '+' : ''}${v}`]
    })
  )

  const general = (
    <div className="flex flex-col gap-(--rd-space-card)">
      <SettingsGroup title="Оформление">
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <span className="text-[15px] leading-5 font-medium text-[var(--rd-heading)]">Тема</span>
          <div role="radiogroup" aria-label="Тема" className="grid grid-cols-3 gap-1 rounded-[12px] bg-[var(--rd-surface)] p-1">
            {themeOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={settings.theme === o.value}
                onClick={() => setTheme(o.value)}
                className={cn(
                  'h-9 cursor-pointer rounded-[9px] text-[14px] font-medium transition-colors',
                  settings.theme === o.value
                    ? 'bg-[var(--rd-field)] text-[var(--rd-heading)] dark:bg-[var(--rd-chip-hover)]'
                    : 'text-[var(--rd-caption)] hover:text-[var(--rd-heading)]'
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup title="Вход в панель">
        <AuthSettingsField authEnabled={settings.authEnabled} onToggle={toggleAuth} showToast={showToast} />
      </SettingsGroup>
    </div>
  )

  const tech = (
    <div className="flex flex-col gap-(--rd-space-card)">
      <button
        type="button"
        className="rd-btn-tile rd-btn-tile--muted min-h-14 w-full text-[15px]"
        onClick={() => {
          close()
          onOpenLog()
        }}
      >
        Журнал Xray, конфиги и списки XKeen
      </button>

      <SettingsGroup title="Журнал">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="xray-log-level">Уровень логов Xray</FieldLabel>
            <FieldDescription>Подробность журнала ошибок. При смене Xray перезапускается</FieldDescription>
          </FieldContent>
          <Select
            value={settings.xrayLogLevel}
            items={Object.fromEntries(XRAY_LOG_LEVELS.map((l) => [l, l]))}
            onValueChange={(v) => void setXrayLogLevel(v as string)}
          >
            <SelectTrigger id="xray-log-level" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {XRAY_LOG_LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="timezone">Часовой пояс</FieldLabel>
            <FieldDescription>Сдвиг времени для записей в журнале</FieldDescription>
          </FieldContent>
          <Select value={String(settings.timezone)} items={timezoneItems} onValueChange={setTimezone}>
            <SelectTrigger id="timezone" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="max-h-72">
              <SelectGroup>
                {Object.entries(timezoneItems).map(([v, label]) => (
                  <SelectItem key={v} value={v}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </SettingsGroup>

      <SettingsGroup title="Маршрутизация">
        <RuExcludeSetting />
      </SettingsGroup>

      <SettingsGroup
        title="Режим GUI"
        notice="Функция экспериментальная. Перед включением сделайте бэкап конфигураций. Несовместимо с комментариями."
      >
        {guiSettings.map((item) => (
          <SwitchSettingField key={item.id} item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
        ))}
      </SettingsGroup>

      <SettingsGroup title="Обновления">
        {updateSettings.map((item) => (
          <SwitchSettingField key={item.id} item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
        ))}
        <RepoSourceField
          repoKey="xrayRepo"
          label="Источник Xray"
          description="Репозиторий GitHub, с которого проверяются и загружаются обновления Xray"
          value={settings.xrayRepo}
          onSave={saveRepoSource}
          showToast={showToast}
        />
        <ProxySettingsField githubProxies={settings.githubProxies} onAddProxy={addProxy} onRemoveProxy={removeProxy} />
      </SettingsGroup>

      <SettingsGroup title="Плагины" notice="Экспериментальные функции, тщательно не тестировались. Используйте на свой страх и риск.">
        {pluginSettings.map((item) => (
          <SwitchSettingField key={item.id} item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
        ))}
      </SettingsGroup>
    </div>
  )

  return (
    <Dialog open={modals.showSettingsModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[88dvh] max-w-xl! flex-col gap-(--rd-space-card) overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Настройки</DialogTitle>
        </DialogHeader>

        {techMenu && (
          <div
            role="tablist"
            aria-label="Разделы настроек"
            className="grid shrink-0 grid-cols-2 gap-1 rounded-[14px] bg-[var(--rd-field)] p-1"
          >
            {[
              { id: 'general', label: 'Основные' },
              { id: 'tech', label: 'Техническое меню' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
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
        )}

        <div className="-mx-(--rd-space-card) min-h-0 scrollbar-thin overflow-y-auto px-(--rd-space-card) pb-1">
          {techMenu && tab === 'tech' ? tech : general}
        </div>
      </DialogContent>
    </Dialog>
  )
}
