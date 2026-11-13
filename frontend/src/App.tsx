import { AnimatePresence, motion } from 'framer-motion'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { LoginForm, RemoteBlocked } from './components/auth/Login'
import { RouterUnreachable } from './components/status/RouterUnreachable'
import { MOBILE_TABS, MobileTabBar, type MobileTab } from './components/home/MobileTabBar'
import { SettingsPage } from './components/home/SettingsPage'
import type { CodeMirrorRef } from './components/configuration/CodeMirror'
import { ConfigPanel, isPanelManagedFile } from './components/configuration/ConfigPanel'

import { LogPanel } from './components/log/LogPanel'
import { ImportModal } from './components/modals/AddOutbound'
import { CommentsWarningModal } from './components/modals/CommentsWarning'
import { CoreManageModal } from './components/modals/CoreManagement'
import { GeoScanModal } from './components/modals/GeoScan'
import { RouteTesterModal } from './components/modals/RouteTester'
import { SettingsModal } from './components/modals/Settings'
import { TemplateModal } from './components/modals/Templates'
import { UpdateModal } from './components/modals/Update'
import { AppHeader } from './components/home/AppHeader'
import { Home } from './components/home/Home'
import { PolicyWarning } from './components/status/PolicyWarning'
import { RoutingWarning } from './components/status/RoutingWarning'
import { Toast } from './components/ui/toast'
import { apiCall } from './lib/api'
import { useLazyMount } from './lib/loader'
import { cn } from './lib/utils'
import { TechNav, TechNavMenu } from './components/home/TechNav'

import { ONLINE_PING_INTERVAL_MS, LOCAL_ROUTER_ID, routerId } from './lib/multi-routers/model'
import { applyRoutersFromSettings, refreshAllOnline } from './lib/multi-routers/actions'
import { useRoutersStore } from './lib/multi-routers/store'
import { getAppState, useAppActions, useModalContext, useSettings } from './lib/store'
import { isTechMenuUnlocked, lockTechMenuOnVersionChange, useTechMenuHotkey, useTechMenuUnlocked } from './lib/techMenu'
import { onConnectionLost, probeRouter, type LoginInfo } from './lib/reachability'
import { applyTheme, THEME_MEDIA_QUERY } from './lib/theme'
import { DEFAULT_XRAY_REPO, type Config, type ThemeMode, type XraySubscription } from './lib/types'
import { parse as parseJsonc } from 'jsonc-parser'

function useThemeMode(theme: ThemeMode) {
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'auto') return

    const media = window.matchMedia(THEME_MEDIA_QUERY)
    const syncTheme = () => applyTheme('auto')

    media.addEventListener('change', syncTheme)
    return () => media.removeEventListener('change', syncTheme)
  }, [theme])
}

interface ModalManagerProps {
  onInstalled: () => void
  onGenerate: (uri: string) => { content: string; type: string } | null
  onAddToConfig: (content: string, position: 'start' | 'end') => void
  onImportTemplate: (url: string) => Promise<void>
  onSubscriptionSaved: () => void
  welcome: boolean
  openModal: (modal: string) => void
  onOpenLog: () => void
  onOpenFile: (file: string) => void
}

const ModalManager = memo(function ModalManager({
  onInstalled,
  onGenerate,
  onAddToConfig,
  onImportTemplate,
  onSubscriptionSaved,
  welcome,
  openModal,
  onOpenLog,
  onOpenFile,
}: ModalManagerProps) {
  const { modals, dispatch } = useModalContext()

  const mountCommentsWarning = useLazyMount(modals.showCommentsWarningModal)
  const mountCoreManage = useLazyMount(modals.showCoreManageModal)
  const mountUpdate = useLazyMount(modals.showUpdateModal)
  const mountImport = useLazyMount(modals.showImportModal)
  const mountTemplate = useLazyMount(modals.showTemplateModal)
  const mountSettings = useLazyMount(modals.showSettingsModal)
  const mountGeoScan = useLazyMount(modals.showGeoScanModal)
  const mountRouteTest = useLazyMount(modals.showRouteTestModal)

  return (
    <>
      {mountCommentsWarning && <CommentsWarningModal />}
      {mountCoreManage && (
        <CoreManageModal
          onOpenUpdate={(core: string) => {
            dispatch({ type: 'SET_UPDATE_MODAL_CORE', core })
            openModal('showUpdateModal')
          }}
        />
      )}
      {mountUpdate && <UpdateModal onInstalled={onInstalled} />}
      {mountImport && (
        <ImportModal onGenerate={onGenerate} onAddToConfig={onAddToConfig} onSubscriptionSaved={onSubscriptionSaved} welcome={welcome} />
      )}
      {mountTemplate && <TemplateModal onImport={onImportTemplate} />}
      {mountSettings && <SettingsModal onOpenLog={onOpenLog} onOpenFile={onOpenFile} />}
      {mountGeoScan && <GeoScanModal />}
      {mountRouteTest && <RouteTesterModal />}
    </>
  )
})

function AppContent({ onLogout }: { onLogout: () => void }) {
  const { dispatch, showToast } = useAppActions()
  const multiRouter = useSettings((s) => s.multiRouter)
  const editorRef = useRef<CodeMirrorRef | null>(null)
  const configActionsRef = useRef<{ switchTab: (index: number) => void; getActiveIndex: () => number }>({
    switchTab: () => {},
    getActiveIndex: () => 0,
  })

  const checkStatus = useCallback(async () => {
    const data = await apiCall<any>('GET', 'control')
    if (!data.success) return null
    const currentCore = data.currentCore || 'xray'
    dispatch({
      type: 'SET_CORE_INFO',
      currentCore,
      coreVersions: getAppState().coreVersions,
      availableCores: data.cores || [],
    })
    dispatch({ type: 'SET_SERVICE_STATUS', status: data.running ? 'running' : 'stopped' })
    return currentCore
  }, [dispatch])

  const loadConfigs = useCallback(
    async (silent = false): Promise<Config[]> => {
      if (!silent) dispatch({ type: 'SET_CONFIGS_LOADING', loading: true })
      try {
        const result = await apiCall<any>('GET', 'configs')
        if (result.success && result.configs) {
          const configs: Config[] = result.configs
            .filter((c: any) => !isPanelManagedFile(c.file))
            .map((c: any) => ({ ...c, savedContent: c.content, isDirty: false }))
          dispatch({ type: 'SET_CONFIGS', configs })
          return configs
        } else {
          if (!silent) dispatch({ type: 'SET_CONFIGS_LOADING', loading: false })
          showToast('Не удалось загрузить конфигурации', 'error')
        }
      } catch (e: any) {
        if (!silent) dispatch({ type: 'SET_CONFIGS_LOADING', loading: false })
        showToast(`${e.message}`, 'error')
      }
      return []
    },
    [dispatch, showToast]
  )

  const checkVersion = useCallback(
    async (showUpdateToast = false) => {
      try {
        const data = await apiCall<any>('GET', 'version')
        if (!data.success) return

        const ui = data['xkeen-ui']
        if (!ui) return

        const xray = data.xray
        const isOutdatedCore = !!xray?.outdated
        const coreVersions: Record<string, string> = xray?.version ? { xray: xray.version } : {}

        dispatch({
          type: 'SET_VERSION',
          version: ui.version,
          isOutdatedUI: !!ui.outdated,
          isOutdatedCore,
        })
        // Новая версия панели (или первый запуск после оригинальной XKeen UI) — меню снова скрыто.
        lockTechMenuOnVersionChange(ui.version)

        if (Object.keys(coreVersions).length > 0) {
          const appState = getAppState()
          dispatch({
            type: 'SET_CORE_INFO',
            currentCore: appState.currentCore,
            coreVersions: { ...appState.coreVersions, ...coreVersions },
            availableCores: appState.availableCores,
          })
        }

        if (!showUpdateToast) return
        if (ui.show_toast)
          showToast({
            title: 'Доступно обновление',
            body: 'Доступна новая версия XKeen UI',
            persistent: true,
            id: 'update-ui',
            ...(ui.link && { action: { url: ui.link } }),
          })

        if (xray?.show_toast)
          showToast({
            title: 'Доступно обновление',
            body: 'Доступна новая версия Xray',
            persistent: true,
            id: 'update-xray',
            ...(xray.link ? { action: { url: xray.link } } : {}),
          })
      } catch {
        /* ignore */
      }
    },
    [dispatch, showToast]
  )

  useEffect(() => {
    const loadSettings = async () => {
      const data = await apiCall<any>('GET', 'settings')
      if (data.success) {
        dispatch({
          type: 'SET_SETTINGS',
          settings: {
            autoApply: data.gui.auto_apply,
            guiRouting: data.gui.routing,
            guiLog: data.gui.log,
            autoCheckUI: data.updater.auto_check_ui ?? true,
            autoCheckCore: data.updater.auto_check_core ?? true,
            backupCore: data.updater.backup_core,
            githubProxies: data.updater.github_proxy || [],
            xrayRepo: data.updater.xray_repo ?? DEFAULT_XRAY_REPO,
            timezone: data.log.timezone,
            xrayLogLevel: data.log.xray_level ?? 'warning',
            authEnabled: !!data.auth?.enabled,
            multiRouter: data.plugins?.multi_router ?? false,
          },
        })
        if (Array.isArray(data.plugins?.routers)) {
          applyRoutersFromSettings(data.plugins.routers)
        }
      }
    }

    const init = async () => {
      try {
        await loadSettings()
        const currentCore = await checkStatus()
        if (currentCore) loadConfigs()
        checkVersion(true)
      } catch {
        showToast('Ошибка инициализации', 'error')
      }
    }

    init()
  }, [checkStatus, loadConfigs, dispatch, showToast, checkVersion])

  // Роутер проверяет обновления сам; страница переспрашивает его, чтобы индикатор появился без перезагрузки.
  // Всплывающее уведомление backend показывает не чаще раза в сутки.
  useEffect(() => {
    const timer = setInterval(() => void checkVersion(true), VERSION_POLL_MS)
    return () => clearInterval(timer)
  }, [checkVersion])

  const onlineTargetsKey = useRoutersStore((s) => [LOCAL_ROUTER_ID, ...s.routers.map(routerId)].join('|'))
  useEffect(() => {
    if (!multiRouter) return
    void refreshAllOnline()
    const timer = setInterval(() => void refreshAllOnline(), ONLINE_PING_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [onlineTargetsKey, multiRouter])

  const refreshConfigsSilently = useCallback(() => loadConfigs(true), [loadConfigs])

  useTechMenuHotkey(
    useCallback(
      (unlocked: boolean) => showToast(unlocked ? 'Техническое меню включено — оно в настройках' : 'Техническое меню скрыто'),
      [showToast]
    )
  )

  // Главный блок: «Подписка и серверы», журнал или редактор файла, выбранного в меню «Технические файлы».
  const [view, setViewState] = useState<View>(() => {
    try {
      // Журнал и файлы открываются только из «Технического меню»: пока оно скрыто — главная.
      const saved = isTechMenuUnlocked() ? localStorage.getItem('ui:view') : null
      return saved === 'files' || saved === 'log' ? saved : 'servers'
    } catch {
      return 'servers'
    }
  })
  const setView = useCallback((next: View) => {
    setViewState(next)
    try {
      localStorage.setItem('ui:view', next)
    } catch {
      /* без хранилища выбор живёт до перезагрузки */
    }
  }, [])
  // Меню скрыли (сочетанием клавиш или после обновления) — с журнала и файлов уходим на главную.
  const techMenuUnlocked = useTechMenuUnlocked()
  // Только в момент скрытия: журнал или файл, открытые самой панелью (например, после
  // «Добавить» → «В начало»), не трогаем.
  const wasUnlockedRef = useRef(techMenuUnlocked)
  useEffect(() => {
    if (wasUnlockedRef.current && !techMenuUnlocked) setView('servers')
    wasUnlockedRef.current = techMenuUnlocked
  }, [techMenuUnlocked, setView])
  // Раздел нижней панели на телефоне. Помнится между запусками, как вкладка в приложении.
  const [mobileTab, setMobileTabState] = useState<MobileTab>(() => {
    try {
      const saved = localStorage.getItem('ui:tab')
      return MOBILE_TABS.some((t) => t.id === saved) ? (saved as MobileTab) : 'home'
    } catch {
      return 'home'
    }
  })
  const setMobileTab = useCallback((tab: MobileTab) => {
    setMobileTabState(tab)
    window.scrollTo({ top: 0 })
    try {
      localStorage.setItem('ui:tab', tab)
    } catch {
      /* без хранилища раздел живёт до перезагрузки */
    }
  }, [])
  // Настройки на телефоне — отдельный экран. Запись в истории, чтобы системный жест «назад» его закрывал.
  const [settingsPage, setSettingsPage] = useState(false)
  useEffect(() => {
    const onPop = () => setSettingsPage(!!window.history.state?.settingsPage)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const closeSettingsPage = useCallback(() => {
    if (window.history.state?.settingsPage) window.history.back()
    else setSettingsPage(false)
  }, [])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const openFile = useCallback(
    (file: string) => {
      setView('files')
      const index = getAppState().configs.findIndex((c) => c.file === file)
      if (index >= 0) configActionsRef.current.switchTab(index)
    },
    [setView]
  )
  const openLog = useCallback(() => setView('log'), [setView])
  const goHome = useCallback(() => {
    setView('servers')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [setView])
  const techNavProps = {
    activeFile: view === 'files' ? activeFile : null,
    logActive: view === 'log',
    onHome: goHome,
    onSelectLog: () => setView('log'),
    onSelectFile: openFile,
  }
  const [subsReloadKey, setSubsReloadKey] = useState(0)
  const [welcome, setWelcome] = useState(false)
  const onSubscriptionSaved = useCallback(() => {
    setWelcome(false)
    setSubsReloadKey((k) => k + 1)
    void refreshConfigsSilently()
  }, [refreshConfigsSilently])

  // Первый вход без подписок — сразу предлагаем добавить подписку (по первой загрузке списка на главной).
  const welcomeCheckedRef = useRef(false)
  const onSubscriptionsLoaded = useCallback(
    (subs: XraySubscription[]) => {
      if (welcomeCheckedRef.current) return
      welcomeCheckedRef.current = true
      if (subs.length > 0) return
      setWelcome(true)
      setTimeout(() => dispatch({ type: 'SHOW_MODAL', modal: 'showImportModal', show: true }), 300)
    },
    [dispatch]
  )

  const generateConfig = useCallback((uri: string) => {
    const existingConfig = editorRef.current?.getValue() ?? ''
    if (typeof (window as any).generateOutbound === 'function') return (window as any).generateOutbound(uri, existingConfig)
    throw new Error('Parser not loaded')
  }, [])

  const importTemplate = useCallback(
    async (url: string) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const content = await res.text()

      // Шаблон открываем в файле по его разделу: { "routing": … } — в *routing*.json и т.п.
      const appState = getAppState()
      const activeIndex = configActionsRef.current.getActiveIndex()
      let targetIndex = activeIndex
      try {
        const section = Object.keys(parseJsonc(content) ?? {})[0]
        const index = section ? appState.configs.findIndex((c) => (c.file.split('/').pop() ?? '').includes(section)) : -1
        if (index >= 0) targetIndex = index
      } catch {
        /* не JSON — в текущий файл */
      }
      if (appState.configs[targetIndex]?.isDirty && !confirm('Несохраненные изменения будут потеряны. Продолжить?'))
        throw new Error('Отменено')
      if (targetIndex !== activeIndex) configActionsRef.current.switchTab(targetIndex)
      setTimeout(() => {
        if (!editorRef.current) return
        editorRef.current.setValue(content)
        dispatch({ type: 'UPDATE_CONFIG_DIRTY', index: targetIndex, isDirty: true, content })
        showToast('Шаблон импортирован')
      }, 0)
    },
    [dispatch, showToast]
  )

  const addToConfig = useCallback(
    (generated: string, position: 'start' | 'end') => {
      const appState = getAppState()
      let targetIndex = configActionsRef.current.getActiveIndex()

      try {
        const obj = parseJsonc(appState.configs[targetIndex].content)
        if (!Array.isArray(obj.outbounds)) throw new Error()
      } catch {
        targetIndex = appState.configs.findIndex((cfg) => {
          try {
            return Array.isArray(parseJsonc(cfg.content).outbounds)
          } catch {
            return false
          }
        })
        if (targetIndex === -1) {
          showToast('Массив outbounds не найден', 'error')
          return
        }
      }

      if (targetIndex !== configActionsRef.current.getActiveIndex()) configActionsRef.current.switchTab(targetIndex)

      setTimeout(() => {
        const editorWrapper = editorRef.current
        if (!editorWrapper) return
        try {
          const obj = parseJsonc(editorWrapper.getValue())
          if (position === 'start') obj.outbounds.unshift(JSON.parse(generated))
          else obj.outbounds.push(JSON.parse(generated))
          editorWrapper.replaceAll(JSON.stringify(obj, null, 2))
          setTimeout(() => editorWrapper.revealLine(position === 'start' ? 1 : editorWrapper.getLineCount()), 0)
        } catch (e: any) {
          showToast(`Ошибка парсинга: ${e.message}`, 'error')
        }
      }, 150)
    },
    [showToast]
  )

  const addToConfigVisible = useCallback(
    (content: string, position: 'start' | 'end') => {
      setView('files')
      addToConfig(content, position)
    },
    [addToConfig, setView]
  )
  const importTemplateVisible = useCallback(
    async (url: string) => {
      setView('files')
      await importTemplate(url)
    },
    [importTemplate, setView]
  )

  const logout = onLogout
  const onInstalled = useCallback(() => void checkVersion(), [checkVersion])
  const openModal = useCallback(
    (modal: string) => setTimeout(() => dispatch({ type: 'SHOW_MODAL', modal: modal as any, show: true }), 0),
    [dispatch]
  )
  const openSettings = useCallback(() => {
    // Десктоп — окно; телефон и планшет (там же нижняя панель) — отдельный экран.
    if (window.matchMedia('(min-width: 1024px)').matches) {
      openModal('showSettingsModal')
      return
    }
    window.history.pushState({ settingsPage: true }, '')
    setSettingsPage(true)
    window.scrollTo({ top: 0 })
  }, [openModal])
  const showTabBar = view === 'servers' && !settingsPage

  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <main className="flex flex-1 flex-col">
        <div
          className={cn(
            'mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-(--rd-space-grid) px-4 pt-(--rd-space-grid) pb-8 sm:px-6',
            // Просвет под нижней панелью разделов: иначе низ раздела уходит под неё.
            showTabBar && 'max-lg:pb-(--mobile-nav-clearance)'
          )}
        >
          <AppHeader
            onOpenSettings={openSettings}
            onBack={settingsPage ? closeSettingsPage : undefined}
            onOpenUpdate={(core) => {
              dispatch({ type: 'SET_UPDATE_MODAL_CORE', core })
              openModal('showUpdateModal')
            }}
            onLogout={logout}
            onHome={goHome}
          />
          {settingsPage && (
            <SettingsPage
              onOpenLog={() => {
                closeSettingsPage()
                openLog()
              }}
            />
          )}
          {/* Экран настроек закрывает разделы, но не размонтирует их: подписка и выбор сервера не грузятся заново. */}
          <div className={settingsPage ? 'hidden' : 'contents'}>
            <RoutingWarning reloadKey={subsReloadKey} />
            <PolicyWarning onRestarted={() => void checkStatus()} />
            <div className={cn(view !== 'servers' && 'hidden')}>
              <Home
                reloadKey={subsReloadKey}
                onChanged={() => void refreshConfigsSilently()}
                onAddNew={() => openModal('showImportModal')}
                onLoaded={onSubscriptionsLoaded}
                onRefreshStatus={() => void checkStatus()}
                mobileTab={mobileTab}
              />
            </div>
            {/* Техническое меню: навигация слева (на телефоне — список сверху), справа редактор файла или журнал. */}
            <div
              className={cn(
                'grid grid-cols-1 items-start gap-(--rd-space-grid) lg:grid-cols-[260px_minmax(0,1fr)]',
                view === 'servers' && 'hidden'
              )}
            >
              <div className="hidden lg:sticky lg:top-[calc(56px+var(--rd-space-grid)+var(--rd-space-head))] lg:block">
                <TechNav {...techNavProps} />
              </div>
              <div className="flex min-w-0 flex-col gap-(--rd-space-grid)">
                <TechNavMenu {...techNavProps} />
                <div className={cn('flex flex-col md:h-[calc(100dvh-180px)] md:min-h-[560px]', view !== 'files' && 'hidden')}>
                  <ConfigPanel
                    editorRef={editorRef}
                    configActionsRef={configActionsRef}
                    onOpenImport={() => openModal('showImportModal')}
                    onOpenTemplate={() => openModal('showTemplateModal')}
                    onOpenGeoScan={() => openModal('showGeoScanModal')}
                    onOpenRouteTest={() => openModal('showRouteTestModal')}
                    onOpenBackups={() => openModal('showBackupsModal')}
                    onRefreshConfigs={refreshConfigsSilently}
                    onActiveFileChange={setActiveFile}
                  />
                </div>
                <div className={cn('flex flex-col md:h-[calc(100dvh-180px)] md:min-h-[560px]', view !== 'log' && 'hidden')}>
                  <LogPanel asPage />
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
      {/* Разделы — только на главном экране: журнал и файлы технического меню — вложенные страницы. */}
      {showTabBar && <MobileTabBar active={mobileTab} onSelect={setMobileTab} />}
      <Toast />
      <ModalManager
        onInstalled={onInstalled}
        onGenerate={generateConfig}
        onAddToConfig={addToConfigVisible}
        onImportTemplate={importTemplateVisible}
        onSubscriptionSaved={onSubscriptionSaved}
        welcome={welcome}
        openModal={openModal}
        onOpenLog={openLog}
        onOpenFile={openFile}
      />
    </div>
  )
}

type View = 'servers' | 'files' | 'log'

const VERSION_POLL_MS = 5 * 60 * 1000

type AuthState = 'loading' | 'login' | 'setup' | 'remote-blocked' | 'authenticated' | 'unreachable'

function authStateFrom(info: LoginInfo): AuthState {
  if (info.authenticated || (!info.enabled && info.local)) return 'authenticated'
  if (!info.enabled) return 'remote-blocked'
  if (info.has_password) return 'login'
  return info.local ? 'setup' : 'remote-blocked'
}

/** Пауза перед повторной проверкой: один сорвавшийся запрос (роутер занят, перезапуск панели
 * после обновления) — ещё не повод закрывать панель экраном недоступности. */
const RECHECK_DELAY_MS = 1500

/** Пока панель открыта, следит за связью с роутером: проверяет при возврате в приложение, при смене
 * сети и при оборванном запросе. Нет ответа дважды подряд — роутер считается потерянным. */
function useConnectionWatch(enabled: boolean, onLost: () => void) {
  const onLostRef = useRef(onLost)
  useEffect(() => {
    onLostRef.current = onLost
  }, [onLost])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let running = false
    const check = async () => {
      if (running) return
      running = true
      let reachable = !!(await probeRouter())
      if (!reachable && !cancelled) {
        await new Promise((resolve) => setTimeout(resolve, RECHECK_DELAY_MS))
        reachable = !!(await probeRouter())
      }
      running = false
      if (!reachable && !cancelled) onLostRef.current()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    const onNetworkChange = () => void check()
    const unsubscribe = onConnectionLost(() => void check())
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onNetworkChange)
    window.addEventListener('offline', onNetworkChange)
    return () => {
      cancelled = true
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onNetworkChange)
      window.removeEventListener('offline', onNetworkChange)
    }
  }, [enabled])
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading')
  /** Связь пропала при открытой панели: экран недоступности поверх неё, чтобы не терять её состояние. */
  const [connectionLost, setConnectionLost] = useState(false)
  const theme = useSettings((s) => s.theme)

  useThemeMode(theme)

  useEffect(() => {
    void probeRouter().then((info) => setAuthState(info ? authStateFrom(info) : 'unreachable'))
  }, [])

  useConnectionWatch(authState === 'authenticated' && !connectionLost, () => setConnectionLost(true))

  /** Роутер снова отвечает. Сессия могла истечь, пока его не было, — тогда на вход. */
  const handleReachable = useCallback((info: LoginInfo) => {
    setConnectionLost(false)
    setAuthState(authStateFrom(info))
  }, [])

  const handleLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    setAuthState('login')
  }, [])

  if (authState === 'loading') return null

  return (
    <>
      {connectionLost && authState === 'authenticated' && <RouterUnreachable overlay onReachable={handleReachable} />}
      <AnimatePresence mode="wait">
        {authState === 'unreachable' ? (
          <motion.div key="unreachable" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <RouterUnreachable onReachable={handleReachable} />
          </motion.div>
        ) : authState === 'remote-blocked' ? (
          <motion.div key="blocked" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <RemoteBlocked />
          </motion.div>
        ) : authState === 'login' || authState === 'setup' ? (
          <motion.div key="login" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <LoginForm mode={authState} onAuth={() => setAuthState('authenticated')} />
            <Toast />
          </motion.div>
        ) : (
          <motion.div key="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <AppContent onLogout={handleLogout} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
