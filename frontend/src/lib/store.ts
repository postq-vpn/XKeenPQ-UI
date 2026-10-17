import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { getStoredTheme } from './theme'
import { DEFAULT_XRAY_REPO, type AppAction, type AppSettings, type AppState, type ToastMessage } from './types'

// ─── Zustand store ─────────────────────────────────────────────────────────────

const initialSettings: AppSettings = {
  theme: getStoredTheme(),
  autoApply: false,
  guiRouting: false,
  guiLog: false,
  autoCheckUI: true,
  autoCheckCore: true,
  backupCore: true,
  githubProxies: [],
  xrayRepo: DEFAULT_XRAY_REPO,
  timezone: 0,
  authEnabled: false,
  multiRouter: false,
}

const initialState: AppState = {
  serviceStatus: 'loading',
  pendingText: '',
  currentCore: '',
  coreVersions: { xray: '' },
  availableCores: [],
  configs: [],
  isConfigsLoading: true,
  settings: initialSettings,
  version: '',
  isOutdatedUI: false,
  isOutdatedCore: false,
  showDirtyModal: false,
  showCoreManageModal: false,
  showUpdateModal: false,
  showImportModal: false,
  showTemplateModal: false,
  showSettingsModal: false,
  showCommentsWarningModal: false,
  showGeoScanModal: false,
  showRouteTestModal: false,
  showBackupsModal: false,
  updateModalCore: '',
  toasts: [],
  pendingSaveAction: null,
}

interface StoreState extends AppState {
  dispatch: (action: AppAction) => void
}

const useStore = create<StoreState>((set) => ({
  ...initialState,

  dispatch: (action: AppAction) =>
    set((state) => {
      switch (action.type) {
        case 'SET_SERVICE_STATUS':
          return { serviceStatus: action.status, pendingText: action.pendingText ?? state.pendingText }
        case 'SET_CORE_INFO':
          return { currentCore: action.currentCore, coreVersions: action.coreVersions, availableCores: action.availableCores }
        case 'SET_CONFIGS_LOADING':
          return { isConfigsLoading: action.loading }
        case 'SET_CONFIGS':
          return { configs: action.configs, isConfigsLoading: false }
        case 'UPDATE_CONFIG_DIRTY': {
          const prevConfig = state.configs[action.index]
          if (!prevConfig) return {}
          const nextContent = action.content !== undefined ? action.content : prevConfig.content
          if (prevConfig.isDirty === action.isDirty && prevConfig.content === nextContent) return {}
          const configs = [...state.configs]
          configs[action.index] = {
            ...prevConfig,
            isDirty: action.isDirty,
            ...(action.content !== undefined && { content: action.content }),
          }
          return { configs }
        }
        case 'SAVE_CONFIG': {
          const prevConfig = state.configs[action.index]
          if (!prevConfig || (prevConfig.content === action.content && prevConfig.savedContent === action.content && !prevConfig.isDirty))
            return {}
          const configs = [...state.configs]
          configs[action.index] = { ...prevConfig, content: action.content, savedContent: action.content, isDirty: false }
          return { configs }
        }
        case 'SET_SETTINGS':
          return { settings: { ...state.settings, ...action.settings } }
        case 'SET_VERSION':
          return { version: action.version, isOutdatedUI: action.isOutdatedUI, isOutdatedCore: action.isOutdatedCore }
        case 'SHOW_MODAL':
          return { [action.modal]: action.show }
        case 'SET_UPDATE_MODAL_CORE':
          return { updateModalCore: action.core }
        case 'ADD_TOAST':
          return { toasts: [action.toast, ...state.toasts] }
        case 'REMOVE_TOAST':
          return { toasts: state.toasts.filter((t) => t.id !== action.id) }
        case 'SET_PENDING_SAVE_ACTION':
          return { pendingSaveAction: action.action }
        default:
          return {}
      }
    }),
}))

// ─── Types ─────────────────────────────────────────────────────────────────────

type ShowToastFn = (
  message: string | { title: string; body: string; persistent?: boolean; id?: string; action?: { url: string } },
  type?: 'success' | 'error' | 'warning'
) => void

type CoreState = Omit<
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
  | 'updateModalCore'
  | 'pendingSaveAction'
  | 'toasts'
  | 'settings'
  | 'configs'
>

type ModalState = Pick<
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
  | 'updateModalCore'
  | 'pendingSaveAction'
>

type CoreStateWithSettings = CoreState & Pick<AppState, 'settings'>
type CoreStateWithConfigs = CoreState & Pick<AppState, 'configs'>
type CoreStateWithConfigsAndSettings = CoreState & Pick<AppState, 'configs' | 'settings'>

const selectCoreState = (s: StoreState): CoreState => ({
  serviceStatus: s.serviceStatus,
  pendingText: s.pendingText,
  currentCore: s.currentCore,
  coreVersions: s.coreVersions,
  availableCores: s.availableCores,
  isConfigsLoading: s.isConfigsLoading,
  version: s.version,
  isOutdatedUI: s.isOutdatedUI,
  isOutdatedCore: s.isOutdatedCore,
})

const selectCoreStateWithSettings = (s: StoreState): CoreStateWithSettings => ({ ...selectCoreState(s), settings: s.settings })
const selectCoreStateWithConfigs = (s: StoreState): CoreStateWithConfigs => ({ ...selectCoreState(s), configs: s.configs })
const selectCoreStateWithConfigsAndSettings = (s: StoreState): CoreStateWithConfigsAndSettings => ({
  ...selectCoreState(s),
  configs: s.configs,
  settings: s.settings,
})

// ─── Hooks & Utilities ─────────────────────────────────────────────────────────

export function showToast(
  message: string | { title: string; body: string; persistent?: boolean; id?: string; action?: { url: string } },
  type: 'success' | 'error' | 'warning' = 'success'
) {
  const dispatch = useStore.getState().dispatch
  const id = typeof message === 'string' ? Math.random().toString(36).slice(2) : (message.id ?? Math.random().toString(36).slice(2))
  if (typeof message !== 'string' && message.id) dispatch({ type: 'REMOVE_TOAST', id: message.id })
  const defaultTitle = type === 'error' ? 'Ошибка' : type === 'warning' ? 'Предупреждение' : 'Успех'
  const toast: ToastMessage =
    typeof message === 'string'
      ? { id, title: defaultTitle, body: message, type }
      : {
          id,
          title: message.title,
          body: message.body,
          type,
          ...(message.persistent && { persistent: true }),
          ...(message.action && { action: message.action }),
        }

  dispatch({ type: 'ADD_TOAST', toast })
  if (!toast.persistent) setTimeout(() => dispatch({ type: 'REMOVE_TOAST', id }), 5000)
}

export function useAppContext(): { state: CoreState; dispatch: (action: AppAction) => void; showToast: ShowToastFn }
export function useAppContext(options: { includeConfigs: true }): {
  state: CoreStateWithConfigs
  dispatch: (action: AppAction) => void
  showToast: ShowToastFn
}
export function useAppContext(options: { includeSettings: true }): {
  state: CoreStateWithSettings
  dispatch: (action: AppAction) => void
  showToast: ShowToastFn
}
export function useAppContext(options: { includeConfigs: true; includeSettings: true }): {
  state: CoreStateWithConfigsAndSettings
  dispatch: (action: AppAction) => void
  showToast: ShowToastFn
}
export function useAppContext(options?: { includeSettings?: boolean; includeConfigs?: boolean }) {
  const selector = options?.includeConfigs
    ? options?.includeSettings
      ? selectCoreStateWithConfigsAndSettings
      : selectCoreStateWithConfigs
    : options?.includeSettings
      ? selectCoreStateWithSettings
      : selectCoreState

  return { state: useStore(useShallow(selector)), dispatch: useStore((s) => s.dispatch), showToast }
}

export function useAppActions() {
  return { dispatch: useStore((s) => s.dispatch), showToast }
}

export function useCoreRuntimeState() {
  return useStore(useShallow((s) => ({ serviceStatus: s.serviceStatus, currentCore: s.currentCore })))
}

export const getAppState = () => useStore.getState()

export function useModalContext() {
  const modals = useStore(
    useShallow((s): ModalState => ({
      showDirtyModal: s.showDirtyModal,
      showCoreManageModal: s.showCoreManageModal,
      showUpdateModal: s.showUpdateModal,
      showImportModal: s.showImportModal,
      showTemplateModal: s.showTemplateModal,
      showSettingsModal: s.showSettingsModal,
      showCommentsWarningModal: s.showCommentsWarningModal,
      showGeoScanModal: s.showGeoScanModal,
      showRouteTestModal: s.showRouteTestModal,
      showBackupsModal: s.showBackupsModal,
      updateModalCore: s.updateModalCore,
      pendingSaveAction: s.pendingSaveAction,
    }))
  )
  return { modals, dispatch: useStore((s) => s.dispatch) }
}

export function useSettings<T>(selector: (settings: AppSettings) => T): T {
  return useStore((s) => selector(s.settings))
}

export const useToasts = () => useStore((s) => s.toasts)
