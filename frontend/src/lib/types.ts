export const DEFAULT_XRAY_REPO = 'https://github.com/XTLS/Xray-core'

export type ThemeMode = 'light' | 'dark' | 'auto'

export interface Config {
  file: string
  content: string
  savedContent: string
  isDirty: boolean
}

export interface AppSettings {
  theme: ThemeMode
  autoApply: boolean
  guiRouting: boolean
  guiLog: boolean
  autoCheckUI: boolean
  autoCheckCore: boolean
  backupCore: boolean
  githubProxies: string[]
  xrayRepo: string
  timezone: number
  authEnabled: boolean
  multiRouter: boolean
}

export interface ProxySubscriptionInfo {
  Upload?: number
  Download?: number
  Total?: number
  Expire?: number
}

/** Сервер подписки Xray (краткая сводка, без ключей). */
export interface XraySubscriptionServer {
  tag: string
  protocol: string
  address?: string
  port?: number
  disabled: boolean
}

/** Подписка Xray (backend: subscriptions/mod.rs). Поля состояния задаёт backend. */
export interface XraySubscription {
  tag: string
  url: string
  interval: number
  /** Обязателен: без него панель не отдаёт подписку. */
  hwid: string
  filter: string
  exclude_filter: string
  exclude_type: string
  fingerprint: string
  /** Теги серверов, отключённых пользователем. */
  disabled_servers: string[]
  /** Выбранный сервер (тег); пусто — первый включённый. Работает под тегом подписки. */
  primary: string
  last_update?: number
  last_attempt?: number
  last_error?: string | null
  servers?: number
  total_servers?: number
  userinfo?: { upload: number; download: number; total: number; expire: number } | null
  /** Последний полученный список серверов, включая отключённые. */
  server_list?: XraySubscriptionServer[]
  /** Подписка «Для прокси»: проксируемые правила routing направлены на её тег. */
  proxy?: boolean
  /** Название от провайдера (profile-title и т.п.), задаёт backend. */
  title?: string
}

export type ServiceStatus = 'loading' | 'running' | 'stopped' | 'pending'

export interface Release {
  version: string
  name: string
  published_at: string
  is_prerelease: boolean
  body: string
  assets: string[]
}

export interface ToastAction {
  url: string
}

export interface ToastMessage {
  id: string
  title: string
  body: string
  type: 'success' | 'error' | 'warning'
  persistent?: boolean
  action?: ToastAction
}

export interface AppState {
  serviceStatus: ServiceStatus
  pendingText: string
  currentCore: string
  coreVersions: Record<string, string>
  availableCores: string[]
  configs: Config[]
  isConfigsLoading: boolean
  settings: AppSettings
  version: string
  isOutdatedUI: boolean
  isOutdatedCore: boolean
  showDirtyModal: boolean
  showCoreManageModal: boolean
  showUpdateModal: boolean
  showImportModal: boolean
  showTemplateModal: boolean
  showSettingsModal: boolean
  showCommentsWarningModal: boolean
  showGeoScanModal: boolean
  showRouteTestModal: boolean
  showBackupsModal: boolean
  updateModalCore: string
  toasts: ToastMessage[]
  pendingSaveAction: (() => void) | null
}

export type AppAction =
  | { type: 'SET_SERVICE_STATUS'; status: ServiceStatus; pendingText?: string }
  | {
      type: 'SET_CORE_INFO'
      currentCore: string
      coreVersions: Record<string, string>
      availableCores: string[]
    }
  | { type: 'SET_CONFIGS_LOADING'; loading: boolean }
  | { type: 'SET_CONFIGS'; configs: Config[] }
  | { type: 'UPDATE_CONFIG_DIRTY'; index: number; isDirty: boolean; content?: string }
  | { type: 'SAVE_CONFIG'; index: number; content: string }
  | { type: 'SET_SETTINGS'; settings: Partial<AppSettings> }
  | { type: 'SET_VERSION'; version: string; isOutdatedUI: boolean; isOutdatedCore: boolean }
  | {
      type: 'SHOW_MODAL'
      modal: keyof Pick<
        AppState,
        | 'showDirtyModal'
        | 'showCoreManageModal'
        | 'showUpdateModal'
        | 'showImportModal'
        | 'showTemplateModal'
        | 'showSettingsModal'
        | 'showCommentsWarningModal'
        | 'showGeoScanModal'
        | 'showRouteTestModal'
        | 'showBackupsModal'
      >
      show: boolean
    }
  | { type: 'SET_UPDATE_MODAL_CORE'; core: string }
  | { type: 'ADD_TOAST'; toast: ToastMessage }
  | { type: 'REMOVE_TOAST'; id: string }
  | { type: 'SET_PENDING_SAVE_ACTION'; action: (() => void) | null }
