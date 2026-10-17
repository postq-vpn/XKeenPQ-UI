import { AnimatePresence, motion } from 'framer-motion'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { LoginForm } from './components/auth/Login'
import type { CodeMirrorRef } from './components/configuration/CodeMirror'
import { ConfigPanel } from './components/configuration/ConfigPanel'

import { LogPanel } from './components/log/LogPanel'
import { ImportModal } from './components/modals/AddOutbound'
import { CommentsWarningModal } from './components/modals/CommentsWarning'
import { CoreManageModal } from './components/modals/CoreManagement'
import { GeoScanModal } from './components/modals/GeoScan'
import { RouteTesterModal } from './components/modals/RouteTester'
import { SettingsModal } from './components/modals/Settings'
import { TemplateModal } from './components/modals/Templates'
import { UpdateModal } from './components/modals/Update'
import { XrayServerDialog, XraySubscriptionsModal } from './components/modals/XraySubscriptions'
import { StatusBar } from './components/status/StatusBar'
import { Toast } from './components/ui/toast'
import { apiCall } from './lib/api'
import { useLazyMount } from './lib/loader'
import { cn } from './lib/utils'
import { TechFilesMenu } from './components/configuration/TechFilesMenu'

import { ONLINE_PING_INTERVAL_MS, LOCAL_ROUTER_ID, routerId } from './lib/multi-routers/model'
import { applyRoutersFromSettings, refreshAllOnline } from './lib/multi-routers/actions'
import { useRoutersStore } from './lib/multi-routers/store'
import { getAppState, useAppActions, useModalContext, useSettings } from './lib/store'
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
}

const ModalManager = memo(function ModalManager({
  onInstalled,
  onGenerate,
  onAddToConfig,
  onImportTemplate,
  onSubscriptionSaved,
  welcome,
  openModal,
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
  // Новая подписка Xray: после закрытия «Добавить подключение» отдельным окном выбираем сервер.
  const [serverPickSub, setServerPickSub] = useState<XraySubscription | null>(null)
  const handleSubscriptionSaved = useCallback(
    (sub: XraySubscription) => {
      onSubscriptionSaved()
      setTimeout(() => setServerPickSub(sub), 200)
    },
    [onSubscriptionSaved]
  )

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
        <ImportModal
          onGenerate={onGenerate}
          onAddToConfig={onAddToConfig}
          onSubscriptionSaved={handleSubscriptionSaved}
          welcome={welcome}
        />
      )}
      <XrayServerDialog
        sub={serverPickSub}
        onClose={() => setServerPickSub(null)}
        onDone={() => {
          setServerPickSub(null)
          onSubscriptionSaved()
        }}
      />
      {mountTemplate && <TemplateModal onImport={onImportTemplate} />}
      {mountSettings && <SettingsModal />}
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
          const configs: Config[] = result.configs.map((c: any) => ({ ...c, savedContent: c.content, isDirty: false }))
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

  const onlineTargetsKey = useRoutersStore((s) => [LOCAL_ROUTER_ID, ...s.routers.map(routerId)].join('|'))
  useEffect(() => {
    if (!multiRouter) return
    void refreshAllOnline()
    const timer = setInterval(() => void refreshAllOnline(), ONLINE_PING_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [onlineTargetsKey, multiRouter])

  const refreshConfigsSilently = useCallback(() => loadConfigs(true), [loadConfigs])

  // Главный блок: «Подписка и серверы», журнал или редактор файла, выбранного в меню «Технические файлы».
  const [view, setViewState] = useState<View>(() => {
    try {
      const saved = localStorage.getItem('ui:view')
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
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const openFile = useCallback(
    (file: string) => {
      setView('files')
      const index = getAppState().configs.findIndex((c) => c.file === file)
      if (index >= 0) configActionsRef.current.switchTab(index)
    },
    [setView]
  )
  const techMenu = (
    <TechFilesMenu
      activeFile={view === 'files' ? activeFile : null}
      logActive={view === 'log'}
      onSelectServers={() => setView('servers')}
      onSelectLog={() => setView('log')}
      onSelectFile={openFile}
    />
  )
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

  return (
    <div className="bg-muted dark:bg-background app-background flex min-h-dvh flex-col">
      <main className="flex flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-3 px-3 py-3">
          <StatusBar
            onOpenCoreManage={() => openModal('showCoreManageModal')}
            onOpenSettings={() => openModal('showSettingsModal')}
            onRefreshStatus={() => void checkStatus()}
            onOpenUpdate={(core: string) => {
              dispatch({ type: 'SET_UPDATE_MODAL_CORE', core })
              openModal('showUpdateModal')
            }}
            onLogout={logout}
          />
          <div className={cn(view !== 'servers' && 'hidden')}>
            <XraySubscriptionsModal
              asPage
              open
              onOpenChange={() => {}}
              reloadKey={subsReloadKey}
              onChanged={() => void refreshConfigsSilently()}
              onAddNew={() => openModal('showImportModal')}
              headerExtra={techMenu}
              onLoaded={onSubscriptionsLoaded}
            />
          </div>
          <div className={cn('flex flex-col md:min-h-[70dvh]', view !== 'files' && 'hidden')}>
            <ConfigPanel
              editorRef={editorRef}
              configActionsRef={configActionsRef}
              onOpenImport={() => openModal('showImportModal')}
              onOpenTemplate={() => openModal('showTemplateModal')}
              onOpenGeoScan={() => openModal('showGeoScanModal')}
              onOpenRouteTest={() => openModal('showRouteTestModal')}
              onOpenBackups={() => openModal('showBackupsModal')}
              onRefreshConfigs={refreshConfigsSilently}
              headerExtra={techMenu}
              onActiveFileChange={setActiveFile}
            />
          </div>
          <div className={cn('flex flex-col md:min-h-[70dvh]', view !== 'log' && 'hidden')}>
            <LogPanel asPage headerExtra={techMenu} />
          </div>
        </div>
      </main>
      <Toast />
      <ModalManager
        onInstalled={onInstalled}
        onGenerate={generateConfig}
        onAddToConfig={addToConfigVisible}
        onImportTemplate={importTemplateVisible}
        onSubscriptionSaved={onSubscriptionSaved}
        welcome={welcome}
        openModal={openModal}
      />
    </div>
  )
}

type View = 'servers' | 'files' | 'log'

type AuthState = 'loading' | 'login' | 'setup' | 'authenticated'

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading')
  const theme = useSettings((s) => s.theme)

  useThemeMode(theme)

  useEffect(() => {
    fetch('/api/auth/login')
      .then((r) => r.json())
      .then((data) => {
        if (!data.enabled || data.authenticated) setAuthState('authenticated')
        else if (!data.has_password) setAuthState('setup')
        else setAuthState('login')
      })
      .catch(() => setAuthState('login'))
  }, [])

  const handleLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    setAuthState('login')
  }, [])

  if (authState === 'loading') return null

  return (
    <AnimatePresence mode="wait">
      {authState === 'login' || authState === 'setup' ? (
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
  )
}
