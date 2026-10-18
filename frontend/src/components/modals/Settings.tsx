import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TechMenuList } from '../configuration/TechFilesMenu'
import { useTechMenuUnlocked } from '../../lib/techMenu'
import { IconAlertCircle, IconSettings, IconX, IconArrowBackUp } from '@tabler/icons-react'
import { Fragment, memo, useCallback, useEffect, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import type { AppSettings, ThemeMode } from '../../lib/types'

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
  { value: 'auto', label: 'Авто' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Темная' },
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
    <Field orientation="horizontal" className="px-0 py-3">
      <FieldContent>
        <FieldLabel htmlFor={item.id}>{item.title}</FieldLabel>
        <FieldDescription className="text-[13px] whitespace-pre-line">{item.description}</FieldDescription>
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
      <div className="bg-input-background flex h-9 min-w-0 flex-1 items-center rounded-md border px-2.5">
        <span className="w-full truncate text-[13px]">{proxy}</span>
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
    <Field className="px-0 py-3">
      <FieldContent>
        <FieldLabel htmlFor="github-proxy-input">GitHub Proxy</FieldLabel>
        <FieldDescription className="text-[13px] text-wrap!">
          Прокси для загрузки обновлений при отсутствии доступа к GitHub, используются по порядку сверху вниз
        </FieldDescription>
      </FieldContent>

      {githubProxies.length === 0 ? (
        <FieldDescription className="py-1 text-[13px]">Прокси не добавлены</FieldDescription>
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
    <Field className="px-0 py-3">
      <FieldContent>
        <FieldLabel htmlFor={`${repoKey}-input`}>{label}</FieldLabel>
        <FieldDescription className="text-[13px] text-wrap!">{description}</FieldDescription>
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

  const resetPassword = useCallback(async () => {
    const res = await fetch('/api/auth/reset', { method: 'POST' })
    const data = await res.json()
    if (data.success) window.location.reload()
    else showToast(data.error ?? 'Ошибка', 'error')
  }, [showToast])

  return (
    <FieldGroup className="gap-0!">
      <Field orientation="horizontal" className="px-0 py-3">
        <FieldContent>
          <FieldLabel>Авторизация</FieldLabel>
          <FieldDescription className="text-[13px]">Защита панели с помощью пароля при входе</FieldDescription>
        </FieldContent>
        <Switch checked={authEnabled} onCheckedChange={onToggle} aria-label="Авторизация" />
      </Field>

      {authEnabled && (
        <>
          <Separator className="my-0" />
          <Field orientation="horizontal" className="px-0 py-3">
            <FieldContent>
              <FieldLabel>Сбросить пароль</FieldLabel>
              <FieldDescription className="text-[13px]">Сбросить старый пароль и установить новый</FieldDescription>
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
                  <PopoverTitle>Вас перекинет на страницу установки пароля. Продолжить?</PopoverTitle>
                </PopoverHeader>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setResetOpen(false)}>
                    Нет
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => void resetPassword()}>
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

interface SettingsModalProps {
  /** Открыть журнал из «Технического меню». */
  onOpenLog: () => void
  /** Открыть конфиг Xray или список XKeen из «Технического меню». */
  onOpenFile: (file: string) => void
}

export function SettingsModal({ onOpenLog, onOpenFile }: SettingsModalProps) {
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

  const setTimezone = useCallback(
    async (value: string) => {
      const offset = parseInt(value, 10)
      const ok = await saveSetting('log.timezone', offset)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { timezone: offset } })
    },
    [dispatch, saveSetting]
  )

  return (
    <Dialog open={modals.showSettingsModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex h-[79dvh]! max-w-xl! flex-col overflow-hidden md:h-142!">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <IconSettings size={24} className="text-chart-2" /> Настройки
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab} className="flex flex-1 flex-col overflow-hidden">
          <div className="scrollbar-none overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <TabsList
              variant="line"
              className="border-border w-max shrink-0 justify-start gap-3 rounded-none border-b px-0 whitespace-nowrap"
            >
              <TabsTrigger value="general">Общие</TabsTrigger>
              {techMenu && <TabsTrigger value="tech">Техническое меню</TabsTrigger>}
            </TabsList>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="pr-2 pl-1">
              <TabsContent value="general">
                <FieldGroup className="gap-0!">
                  <p className="text-muted-foreground pt-3 pb-1 text-xs font-medium tracking-wider uppercase">Оформление</p>
                  <Field orientation="horizontal" className="px-0 py-3">
                    <FieldContent>
                      <FieldLabel htmlFor="theme">Тема приложения</FieldLabel>
                      <FieldDescription className="text-[13px]">Ручной режим или синхронизация с системой</FieldDescription>
                    </FieldContent>
                    <Select
                      value={settings.theme}
                      items={Object.fromEntries(themeOptions.map((o) => [o.value, o.label]))}
                      onValueChange={setTheme}
                    >
                      <SelectTrigger id="theme" className="w-34 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {themeOptions.map((item) => (
                            <SelectItem key={item.value} value={item.value} className="text-sm">
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Separator className="my-2" />
                  <p className="text-muted-foreground pt-3 pb-1 text-xs font-medium tracking-wider uppercase">Авторизация</p>
                  <AuthSettingsField authEnabled={settings.authEnabled} onToggle={toggleAuth} showToast={showToast} />
                  <Separator className="my-2" />
                  <p className="text-muted-foreground pt-1 pb-1 text-xs font-medium tracking-wider uppercase">Журнал</p>
                  <Field orientation="horizontal" className="px-0 py-3">
                    <FieldContent>
                      <FieldLabel htmlFor="timezone">Часовой пояс</FieldLabel>
                      <FieldDescription className="text-[13px]">Сдвиг времени для записей в журнале</FieldDescription>
                    </FieldContent>
                    <Select
                      value={String(settings.timezone)}
                      items={Object.fromEntries(
                        Array.from({ length: 27 }, (_, i) => {
                          const v = String(i - 12)
                          return [v, `UTC${i - 12 >= 0 ? '+' : ''}${v}`]
                        })
                      )}
                      onValueChange={setTimezone}
                    >
                      <SelectTrigger id="timezone" className="w-30 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {Array.from({ length: 27 }, (_, i) => i - 12).map((offset) => (
                            <SelectItem key={offset} value={String(offset)} className="text-sm">
                              UTC{offset >= 0 ? '+' : ''}
                              {offset}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
              </TabsContent>

              <TabsContent value="tech">
                <TechMenuList
                  onSelectLog={() => {
                    close()
                    onOpenLog()
                  }}
                  onSelectFile={(file) => {
                    close()
                    onOpenFile(file)
                  }}
                />
                <Separator className="my-3" />
                <p className="text-muted-foreground pt-4 pb-1 text-xs font-medium tracking-wider uppercase">Режим GUI</p>
                <Alert className="my-2 border-amber-500/20 bg-amber-100 p-2.75 text-yellow-600 dark:bg-[#2a1f0d] dark:text-amber-400">
                  <IconAlertCircle className="size-4.5" />
                  <AlertDescription className="text-xs leading-4.25 tracking-wide text-yellow-600 dark:text-amber-400">
                    Функция экспериментальная. Перед включением сделайте бэкап конфигураций. Несовместимо с комментариями.
                  </AlertDescription>
                </Alert>

                <FieldGroup className="gap-0!">
                  {guiSettings.map((item, index) => (
                    <Fragment key={item.id}>
                      <SwitchSettingField item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
                      {index < guiSettings.length - 1 && <Separator className="my-0" />}
                    </Fragment>
                  ))}
                </FieldGroup>
                <Separator className="my-3" />
                <p className="text-muted-foreground pt-4 pb-1 text-xs font-medium tracking-wider uppercase">Обновления</p>
                <FieldGroup className="gap-0!">
                  {updateSettings.map((item) => (
                    <Fragment key={item.id}>
                      <SwitchSettingField item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
                      <Separator className="my-0" />
                    </Fragment>
                  ))}
                  <p className="text-muted-foreground pt-3 pb-1 text-xs font-medium tracking-wider uppercase">Источники обновлений</p>
                  <RepoSourceField
                    repoKey="xrayRepo"
                    label="Источник Xray"
                    description="Репозиторий GitHub, с которого загружаются/проверяются обновления Xray"
                    value={settings.xrayRepo}
                    onSave={saveRepoSource}
                    showToast={showToast}
                  />
                  <Separator className="my-0" />
                  <ProxySettingsField githubProxies={settings.githubProxies} onAddProxy={addProxy} onRemoveProxy={removeProxy} />
                </FieldGroup>
                <Separator className="my-3" />
                <p className="text-muted-foreground pt-4 pb-1 text-xs font-medium tracking-wider uppercase">Плагины</p>
                <Alert className="my-2 border-amber-500/20 bg-amber-100 p-2.75 text-yellow-600 dark:bg-[#2a1f0d] dark:text-amber-400">
                  <IconAlertCircle className="size-4.5" />
                  <AlertDescription className="text-xs leading-4.25 tracking-wide text-yellow-600 dark:text-amber-400">
                    Функционал данного раздела экспериментален и не проходит тщательное тестирование. Использовать на свой страх и риск.
                  </AlertDescription>
                </Alert>

                <FieldGroup className="gap-0!">
                  {pluginSettings.map((item, index) => (
                    <Fragment key={item.id}>
                      <SwitchSettingField item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
                      {index < pluginSettings.length - 1 && <Separator className="my-0" />}
                    </Fragment>
                  ))}
                </FieldGroup>
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
