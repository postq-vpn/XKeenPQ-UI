import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconBox,
  IconBoltFilled,
  IconCheck,
  IconCode,
  IconDeviceFloppy,
  IconDotsFilled,
  IconExternalLinkFilled,
  IconFilePlus,
  IconFileText,
  IconLink,
  IconPencil,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { apiCall, getFileLanguage } from '../../lib/api'
import { LazyBoundary, lazyLoad, useLazyMount } from '../../lib/loader'
import {
  runMassTask,
  summarizeFanOut,
  targetLabel,
  filterAuthBlockedTargets,
  REMOTE_AUTH_UNSUPPORTED,
} from '../../lib/multi-routers/actions'
import { LOCAL_ROUTER_ID } from '../../lib/multi-routers/model'
import { useRoutersStore } from '../../lib/multi-routers/store'
import { useAppContext, useModalContext, useSettings } from '../../lib/store'
import type { Config } from '../../lib/types'
import { cn } from '../../lib/utils'
import { parse as parseJsonc } from 'jsonc-parser'
import { MassConfirmDialog } from '../log/multi-routers/MassConfirmDialog'
import { BackupsModal } from '../modals/Backups'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { CodeMirrorRef } from './CodeMirror'

const GuiRouting = lazyLoad(() => import('./xray/GuiRouting'), 'GuiRouting')
const GuiLog = lazyLoad(() => import('./xray/GuiLog'), 'GuiLog')
const CodeMirrorEditorLazy = lazyLoad(() => import('./CodeMirror'), 'CodeMirrorEditor')

const BackupsModalContainer = memo(function BackupsModalContainer({ onRefreshConfigs }: { onRefreshConfigs: () => Promise<unknown> }) {
  const { modals, dispatch } = useModalContext()
  const mounted = useLazyMount(modals.showBackupsModal)
  const handleOpenChange = useCallback(
    (open: boolean) => dispatch({ type: 'SHOW_MODAL', modal: 'showBackupsModal', show: open }),
    [dispatch]
  )
  if (!mounted) return null
  return <BackupsModal open={modals.showBackupsModal} onOpenChange={handleOpenChange} onRefreshConfigs={onRefreshConfigs} />
})

type ApiResult = { success: boolean; error?: string }

export const isXkeenFile = (file: string) => file.startsWith('/opt/etc/xkeen')

/** Настройки логов Xray закреплены панелью (backend: xray_log.rs) — файл не показывается. */
export const isPanelManagedFile = (file: string) => file.endsWith('/01_log.json')

/** Подпись вкладки: имя файла без расширения и номера-префикса, файлы подписок — «sub: <тег>». */
export const tabLabel = (file: string) =>
  (file.split('/').pop() ?? file)
    .replace(/\.[^.]+$/, '')
    .replace(/^\d+_outbounds_sub\./, 'sub: ')
    .replace(/^\d+_/, '')

interface Props {
  onOpenImport: () => void
  onOpenTemplate: () => void
  onOpenGeoScan: () => void
  onOpenRouteTest: () => void
  onOpenBackups: () => void
  onRefreshConfigs: () => Promise<Config[]>
  editorRef: React.RefObject<CodeMirrorRef | null>
  configActionsRef: React.RefObject<{ switchTab: (index: number) => void; getActiveIndex: () => number }>
  /** Справа в заголовке (меню «Технические файлы»). */
  headerExtra?: React.ReactNode
  /** Сообщает родителю открытый файл — для подписи меню. */
  onActiveFileChange?: (file: string) => void
}

interface ConfigTabProps {
  config: Config
  showToast: (msg: string, type?: 'success' | 'error') => void
  onRefreshConfigs: () => Promise<Config[]>
  withContextMenu?: boolean
}

type DialogState =
  | { type: 'create'; dir: string; isLst: boolean; anchorFile: string }
  | { type: 'rename'; file: string }
  | { type: 'delete'; file: string }
  | null

function ConfigTab({ config, showToast, onRefreshConfigs, withContextMenu = false }: ConfigTabProps) {
  const [dialogData, setDialogData] = useState<DialogState>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const pendingInputFocusRef = useRef(false)
  const [inputValue, setInputValue] = useState('')

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  const openDialog = (value: NonNullable<DialogState>) => {
    pendingInputFocusRef.current = value.type !== 'delete'
    setDialogData(value)
    setPopoverOpen(true)
  }

  const closeDialog = () => setPopoverOpen(false)

  const fileExt = useMemo(() => {
    if (!dialogData || dialogData.type === 'delete') return ''
    if (dialogData.type === 'rename') return dialogData.file.match(/(\.[^.]+)$/)?.[1] ?? ''
    return dialogData.isLst ? '.lst' : '.json'
  }, [dialogData])

  async function commitDialog() {
    if (!dialogData) return
    const val = inputValue.trim()
    const ext = fileExt

    let req: { method: 'POST' | 'PATCH' | 'DELETE'; body: Record<string, any>; msg: string }

    if (dialogData.type === 'create') {
      if (!val) return
      req = { method: 'POST', body: { file: `${dialogData.dir}/${val}${ext}`, content: '' }, msg: `Файл "${val}${ext}" создан` }
    } else if (dialogData.type === 'rename') {
      if (!val) return
      const dir = dialogData.file.substring(0, dialogData.file.lastIndexOf('/'))
      req = { method: 'PATCH', body: { file: dialogData.file, new_file: `${dir}/${val}${ext}` }, msg: `Файл переименован в "${val}${ext}"` }
    } else {
      req = { method: 'DELETE', body: { file: dialogData.file }, msg: `Файл "${dialogData.file.split('/').pop()}" удалён` }
    }

    const result = await apiCall<{ success: boolean; error?: string }>(req.method, 'configs', req.body)

    if (result.success) {
      showToast(req.msg)
      await onRefreshConfigs()
      closeDialog()
    } else {
      showToast(`Ошибка: ${result.error}`, 'error')
    }
  }

  const tabsTrigger = (
    <TabsTrigger value={config.file} className="dark:data-[state=active]:bg-input-background! relative data-[state=active]:bg-white!">
      {tabLabel(config.file)}
      {config.isDirty && <span className="absolute top-0.75 right-0.75 h-1.5 w-1.5 rounded-full bg-amber-400" />}
    </TabsTrigger>
  )

  if (!withContextMenu)
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex">{tabsTrigger}</span>} />
        <TooltipContent className="text-[13px]">{config.file}</TooltipContent>
      </Tooltip>
    )

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(open) => {
        if (!open) setPopoverOpen(false)
      }}
    >
      <ContextMenu>
        <ContextMenuTrigger className="contents">
          <Tooltip>
            <PopoverTrigger render={<TooltipTrigger render={<span className="inline-flex">{tabsTrigger}</span>} />} />
            <TooltipContent className="text-[13px]">{config.file}</TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(e) => {
            if (pendingInputFocusRef.current) {
              e.preventDefault()
              pendingInputFocusRef.current = false
              requestAnimationFrame(() => inputRef.current?.focus())
            }
          }}
        >
          <ContextMenuItem
            onSelect={() => {
              const dir = config.file.substring(0, config.file.lastIndexOf('/'))
              setInputValue('')
              openDialog({ type: 'create', dir, isLst: config.file.endsWith('.lst'), anchorFile: config.file })
            }}
          >
            <IconFilePlus /> Создать файл
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              const name =
                config.file
                  .split('/')
                  .pop()
                  ?.replace(/\.[^.]+$/, '') ?? ''
              setInputValue(name)
              openDialog({ type: 'rename', file: config.file })
            }}
          >
            <IconPencil /> Переименовать
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => openDialog({ type: 'delete', file: config.file })}>
            <IconTrash /> Удалить
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent align="start" className="w-auto min-w-64" avoidCollisions={!isMobile}>
        {dialogData?.type === 'delete' ? (
          <>
            <p className="text-sm font-medium">Удалить «{config.file.split('/').pop()}»?</p>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={closeDialog}>
                Отмена
              </Button>
              <Button size="sm" variant="destructive" onClick={commitDialog}>
                Удалить
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">{dialogData?.type === 'create' ? 'Создать файл' : 'Переименовать файл'}</p>
            <InputGroup>
              <InputGroupInput
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commitDialog()}
                placeholder="Имя файла"
              />
              {fileExt && (
                <InputGroupAddon align="inline-end">
                  <InputGroupText>{fileExt}</InputGroupText>
                </InputGroupAddon>
              )}
            </InputGroup>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={closeDialog}>
                Отмена
              </Button>
              <Button size="sm" onClick={commitDialog}>
                {dialogData?.type === 'create' ? 'Создать' : 'Переименовать'}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function ConfigPanel({
  onOpenImport,
  onOpenTemplate,
  onOpenGeoScan,
  onOpenRouteTest,
  onOpenBackups,
  onRefreshConfigs,
  editorRef,
  configActionsRef,
  headerExtra,
  onActiveFileChange,
}: Props) {
  const { state, dispatch, showToast } = useAppContext({ includeConfigs: true })
  const { configs, isConfigsLoading, serviceStatus } = state
  const guiRouting = useSettings((s) => s.guiRouting)
  const guiLog = useSettings((s) => s.guiLog)
  const multiRouter = useSettings((s) => s.multiRouter)
  const applyTargets = useRoutersStore((s) => s.applyTargets)
  const getMassTargets = () => {
    if (!multiRouter) return [LOCAL_ROUTER_ID]
    return applyTargets.length > 0 ? applyTargets : [LOCAL_ROUTER_ID]
  }

  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending'

  const [activeConfigFile, setActiveConfigFile] = useState<string>(() => localStorage.getItem('lastSelectedTab') ?? '')
  const activeConfigIndex = useMemo(() => {
    if (!configs.length) return 0
    const idx = configs.findIndex((c) => c.file === activeConfigFile)
    return idx >= 0 ? idx : 0
  }, [configs, activeConfigFile])
  const [validationState, setValidationState] = useState<{ isValid: boolean; error?: string } | null>(null)

  const [isEditorMounted, setIsEditorMounted] = useState(false)

  const [massConfirm, setMassConfirm] = useState<{
    title: string
    description: string
    targets: string[]
    action: () => void
  } | null>(null)

  const configsRef = useRef(configs)
  const activeIndexRef = useRef(activeConfigIndex)
  const viewStatesRef = useRef<Record<string, any>>({})

  useEffect(() => {
    configsRef.current = configs
  }, [configs])
  useEffect(() => {
    activeIndexRef.current = activeConfigIndex
  }, [activeConfigIndex])

  const saveViewState = useCallback(
    (file: string, isDirty?: boolean) => {
      if (!editorRef.current) return
      const state = editorRef.current.saveViewState()
      if (state) {
        viewStatesRef.current[file] = state
        if (!isDirty) {
          try {
            localStorage.setItem(`editor-folds:${file}`, JSON.stringify(state.folds ?? []))
          } catch {
            /* */
          }
        }
      }
    },
    [editorRef]
  )

  useEffect(() => {
    function onBeforeUnload() {
      const currentCfg = configsRef.current[activeIndexRef.current]
      if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [saveViewState])

  const configFilenamesKey = configs.map((c) => c.file).join(',')

  const activeConfig = configs[activeConfigIndex]
  const activeFile = activeConfig?.file
  useEffect(() => {
    if (activeFile) onActiveFileChange?.(activeFile)
  }, [activeFile, onActiveFileChange])
  const fileLanguage = activeConfig ? getFileLanguage(activeConfig.file) : null
  const isJson = fileLanguage === 'json'
  const canSave = !!(activeConfig?.isDirty && validationState?.isValid)
  const canApply = canSave && isRunning && !isPending
  const canFormat = !!(isJson && validationState?.isValid)

  const loadConfigIntoEditor = useCallback(
    (config: Config) => {
      if (!editorRef.current) return
      editorRef.current.setSavedContent(config.savedContent)
      const inMemory = viewStatesRef.current[config.file]
      editorRef.current.setValue(config.content, config.savedContent, inMemory?.history)
      editorRef.current.setLanguage(getFileLanguage(config.file))
      editorRef.current.validate(config.file)
      if (inMemory) {
        editorRef.current.restoreViewState(inMemory)
      } else {
        const folds = (() => {
          try {
            return JSON.parse(localStorage.getItem(`editor-folds:${config.file}`) ?? 'null')
          } catch {
            return null
          }
        })()
        if (folds) editorRef.current.restoreViewState({ anchor: 0, head: 0, scrollTop: 0, scrollLeft: 0, folds })
      }
    },
    [editorRef]
  )

  useEffect(() => {
    const config = configsRef.current[activeConfigIndex]
    if (editorRef.current && config) {
      loadConfigIntoEditor(config)
    }
  }, [activeConfigIndex, configFilenamesKey, loadConfigIntoEditor, editorRef])

  const savedContentKey = activeConfig?.savedContent
  useEffect(() => {
    const config = configsRef.current[activeConfigIndex]
    if (editorRef.current && config) {
      loadConfigIntoEditor(config)
    }
  }, [activeConfigIndex, savedContentKey, loadConfigIntoEditor, editorRef])

  const handleEditorReady = useCallback(() => {
    setIsEditorMounted(true)
    const config = configsRef.current[activeIndexRef.current]
    if (config && editorRef.current) loadConfigIntoEditor(config)
  }, [loadConfigIntoEditor, editorRef])

  const handleContentChange = useCallback(
    (content: string, isDirty: boolean) => {
      const index = activeIndexRef.current
      if (index < 0) return
      const current = configsRef.current[index]
      if (!current) return
      if (current.content === content && current.isDirty === isDirty) return
      dispatch({ type: 'UPDATE_CONFIG_DIRTY', index, isDirty, content })
    },
    [dispatch]
  )

  const handleValidationChange = useCallback((isValid: boolean, error?: string) => {
    setValidationState((prev) => (prev?.isValid === isValid && prev?.error === error ? prev : { isValid, error }))
  }, [])

  const refreshConfigsAndEditor = useCallback(async () => {
    const currentCfg = configsRef.current[activeIndexRef.current]
    if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)

    const targetFile = currentCfg?.file ?? activeConfigFile
    const nextConfigs = await onRefreshConfigs()
    const nextConfig = nextConfigs.find((config) => config.file === targetFile) ?? nextConfigs[0]

    if (nextConfig) {
      if (nextConfig.file !== activeConfigFile) {
        setActiveConfigFile(nextConfig.file)
        localStorage.setItem('lastSelectedTab', nextConfig.file)
      }
      loadConfigIntoEditor(nextConfig)
    }

    return nextConfigs
  }, [activeConfigFile, loadConfigIntoEditor, onRefreshConfigs, saveViewState])

  const switchTab = useCallback(
    (index: number) => {
      if (index === activeIndexRef.current) return
      const currentCfg = configsRef.current[activeIndexRef.current]
      if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)

      const file = configsRef.current[index]?.file ?? ''
      setActiveConfigFile(file)
      localStorage.setItem('lastSelectedTab', file)
    },
    [saveViewState]
  )

  useEffect(() => {
    configActionsRef.current = { switchTab, getActiveIndex: () => activeIndexRef.current }
  }, [configActionsRef, switchTab])

  async function executeSave(targets: string[], cfg: Config, content: string, targetIndex: number) {
    const results = await runMassTask(targets, async (_id, baseUrl) => {
      const result = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', { file: cfg.file, content }, { baseUrl })
      if (!result.success) throw new Error(result.error || 'ошибка сохранения')
    })

    const localOk = results.find((r) => r.id === LOCAL_ROUTER_ID)?.ok
    if (targets.includes(LOCAL_ROUTER_ID) ? localOk : results.some((r) => r.ok)) {
      const currentConfigs = configsRef.current
      let finalIndex = currentConfigs.findIndex((c) => c.file === cfg.file)
      if (finalIndex < 0) finalIndex = targetIndex
      dispatch({ type: 'SAVE_CONFIG', index: finalIndex, content })
      if (configsRef.current[activeIndexRef.current]?.file === cfg.file) {
        editorRef.current?.setSavedContent(content)
        saveViewState(cfg.file, false)
      }
    }

    const summary = summarizeFanOut(results)
    const fileName = cfg.file.split('/').pop()
    if (results.length <= 1) {
      showToast(
        summary.fail === 0 ? `Файл "${fileName}" сохранен` : errorToastText(summary.body, 'Ошибка сохранения'),
        summary.fail === 0 ? 'success' : 'error'
      )
    } else {
      showToast(
        {
          title: summary.fail === 0 ? `Файл "${fileName}" сохранен` : 'Сохранение завершено с ошибками',
          body: summary.body,
        },
        summary.fail === 0 ? 'success' : 'error'
      )
    }
  }

  async function resolveMassTargets(): Promise<string[] | null> {
    const selected = getMassTargets()
    const { allowed, blocked } = await filterAuthBlockedTargets(selected)
    if (blocked.length > 0) {
      showToast(
        {
          title: 'Пропущены панели с авторизацией',
          body: `${blocked.map(targetLabel).join(', ')}. ${REMOTE_AUTH_UNSUPPORTED}`,
        },
        'error'
      )
    }
    if (allowed.length === 0) return null
    return allowed
  }

  async function saveCurrentConfig(force = false) {
    const targetIndex = activeIndexRef.current
    const cfg = configsRef.current[targetIndex]
    if (!cfg || !editorRef.current) return
    const content = editorRef.current.getValue()
    if (!content.trim() && !cfg.file.endsWith('.lst')) return showToast('Конфигурация пустая', 'error')
    if (!editorRef.current.isValid(cfg.file)) return showToast('Файл содержит ошибки', 'error')
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: () => saveCurrentConfig(true) })
      dispatch({ type: 'SHOW_MODAL', modal: 'showCommentsWarningModal', show: true })
      return
    }

    const targets = await resolveMassTargets()
    if (!targets) return
    const hasRemote = targets.some((t) => t !== LOCAL_ROUTER_ID)
    if (hasRemote) {
      setMassConfirm({
        title: 'Массовое сохранение',
        description: 'Конфиг будет сохранён на выбранных роутерах:',
        targets: targets.map(targetLabel),
        action: () => void executeSave(targets, cfg, content, targetIndex),
      })
      return
    }

    await executeSave(targets, cfg, content, targetIndex)
  }

  function restartActionFor(cfg: Config, content: string) {
    const lang = getFileLanguage(cfg.file)
    return !isXkeenFile(cfg.file) && lang === 'json' && !hasCriticalChanges(cfg.savedContent, content) ? 'softRestart' : 'hardRestart'
  }

  async function applyToHost(baseUrl: string | null, cfg: Config, content: string) {
    const validate = isXkeenFile(cfg.file) ? '' : '?validate=xray'
    const saveResult = await apiCall<ApiResult>(
      'PUT',
      `configs${validate}`,
      { file: cfg.file, content },
      {
        baseUrl,
      }
    )
    if (!saveResult.success) {
      throw new Error(
        saveResult.error === 'Validation failed' ? 'Ошибка валидации Xray: проверьте журнал' : saveResult.error || 'Ошибка сохранения'
      )
    }

    const restartResult = await apiCall<ApiResult>('POST', 'control', { action: restartActionFor(cfg, content) }, { baseUrl })
    if (!restartResult?.success) throw new Error(restartResult?.error || 'ошибка перезапуска')
  }

  async function executeApply(targets: string[], cfg: Config, content: string, targetIndex: number) {
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Применение...' })
    const results = await runMassTask(targets, (_id, baseUrl) => applyToHost(baseUrl, cfg, content))

    const localOk = results.find((r) => r.id === LOCAL_ROUTER_ID)?.ok
    if (targets.includes(LOCAL_ROUTER_ID) ? localOk : results.some((r) => r.ok)) {
      const currentConfigs = configsRef.current
      let finalIndex = currentConfigs.findIndex((c) => c.file === cfg.file)
      if (finalIndex < 0) finalIndex = targetIndex
      dispatch({ type: 'SAVE_CONFIG', index: finalIndex, content })
      if (configsRef.current[activeIndexRef.current]?.file === cfg.file) {
        editorRef.current?.setSavedContent(content)
        saveViewState(cfg.file, false)
      }
    }

    const summary = summarizeFanOut(results)
    if (results.length <= 1) {
      showToast(summary.fail === 0 ? 'Изменения применены' : errorToastText(summary.body), summary.fail === 0 ? 'success' : 'error')
    } else {
      showToast(
        {
          title: summary.fail === 0 ? 'Изменения применены' : 'Применение завершено с ошибками',
          body: summary.body,
        },
        summary.fail === 0 ? 'success' : 'error'
      )
    }

    if (targets.includes(LOCAL_ROUTER_ID)) {
      const nextStatus = localOk === false ? 'stopped' : isRunning || localOk ? 'running' : 'stopped'
      dispatch({
        type: 'SET_SERVICE_STATUS',
        status: nextStatus,
      })
    } else {
      dispatch({ type: 'SET_SERVICE_STATUS', status: isRunning ? 'running' : 'stopped' })
    }
  }

  async function saveAndApply(force = false) {
    const targetIndex = activeIndexRef.current
    const cfg = configsRef.current[targetIndex]
    if (!cfg || !editorRef.current) return
    const content = editorRef.current.getValue()
    if (!content.trim() && !cfg.file.endsWith('.lst')) return showToast('Файл пустой', 'error')
    if (!editorRef.current.isValid(cfg.file)) return showToast('Файл содержит ошибки', 'error')
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: () => saveAndApply(true) })
      dispatch({ type: 'SHOW_MODAL', modal: 'showCommentsWarningModal', show: true })
      return
    }

    const targets = await resolveMassTargets()
    if (!targets) return
    const hasRemote = targets.some((t) => t !== LOCAL_ROUTER_ID)
    if (hasRemote) {
      setMassConfirm({
        title: 'Массовое применение',
        description: 'Конфиг будет сохранён и применён на выбранных роутерах:',
        targets: targets.map(targetLabel),
        action: () => void executeApply(targets, cfg, content, targetIndex),
      })
      return
    }

    await executeApply(targets, cfg, content, targetIndex)
  }

  async function executeQuickBackup(targets: string[]) {
    const results = await runMassTask(targets, async (_id, baseUrl) => {
      const result = await apiCall<{ success: boolean; error?: string }>('PUT', 'backup', undefined, { baseUrl })
      if (!result.success) throw new Error(result.error || 'ошибка бэкапа')
    })
    const summary = summarizeFanOut(results)
    if (results.length <= 1) {
      showToast(summary.fail === 0 ? 'Быстрый бэкап создан' : errorToastText(summary.body), summary.fail === 0 ? 'success' : 'error')
    } else {
      showToast(
        {
          title: summary.fail === 0 ? 'Быстрый бэкап создан' : 'Бэкап завершён с ошибками',
          body: summary.body,
        },
        summary.fail === 0 ? 'success' : 'error'
      )
    }
  }

  async function quickBackup() {
    const targets = await resolveMassTargets()
    if (!targets) return
    const hasRemote = targets.some((t) => t !== LOCAL_ROUTER_ID)
    if (hasRemote) {
      setMassConfirm({
        title: 'Быстрый бэкап',
        description: 'Бэкап конфигураций будет создан на выбранных роутерах:',
        targets: targets.map(targetLabel),
        action: () => void executeQuickBackup(targets),
      })
      return
    }
    void executeQuickBackup(targets)
  }

  function isGuiActive(cfg: Config) {
    const f = cfg.file.toLowerCase()
    return (f.includes('routing') && guiRouting) || (f.includes('log') && guiLog)
  }

  const fileForGui = activeConfig?.file
  const contentForGui = activeConfig?.savedContent
  const isRoutingGui = useMemo(() => {
    if (!guiRouting || !fileForGui) return false
    if (!fileForGui.toLowerCase().includes('routing')) return false
    try {
      const j = parseJsonc(contentForGui || '')
      return j && typeof j.routing === 'object'
    } catch {
      return false
    }
  }, [guiRouting, fileForGui, contentForGui])

  const isLogGui = useMemo(() => {
    if (!guiLog || !fileForGui) return false
    if (!fileForGui.toLowerCase().includes('log')) return false
    try {
      const j = parseJsonc(contentForGui || '')
      return j && typeof j.log === 'object'
    } catch {
      return false
    }
  }, [guiLog, fileForGui, contentForGui])

  const isAnyGui = isRoutingGui || isLogGui

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const usefulLinks = [
    { title: 'Инструкция XKeen', url: 'https://github.com/Corvus-Malus/XKeen/' },
    { title: 'FAQ XKeen', url: 'https://jameszero.net/faq-xkeen.htm' },
    { title: 'Документация Xray', url: 'https://xtls.github.io/ru/config' },
  ]

  return (
    <TooltipProvider delayDuration={500}>
      <>
        <div className="border-border bg-card flex flex-col overflow-hidden rounded-xl border md:min-h-0 md:flex-1">
          <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 sm:px-4 sm:pt-4">
            <div className="flex flex-wrap items-center gap-2">
              {isConfigsLoading ? (
                <Skeleton className="h-9 w-48 rounded-lg" />
              ) : (
                activeConfig && (
                  <Tabs value={activeConfig.file} className="min-w-0 flex-row!">
                    <TabsList className="shrink-0">
                      <ConfigTab
                        key={activeConfig.file}
                        config={activeConfig}
                        showToast={showToast}
                        onRefreshConfigs={refreshConfigsAndEditor}
                        withContextMenu={!isXkeenFile(activeConfig.file)}
                      />
                    </TabsList>
                  </Tabs>
                )
              )}
              {activeConfig && (
                <span className="text-muted-foreground hidden min-w-0 truncate font-mono text-xs sm:inline">{activeConfig.file}</span>
              )}
              <div className="ml-auto flex items-center gap-2">{headerExtra}</div>
            </div>
          </div>

          <div className="relative min-h-175! md:min-h-0 md:flex-1">
            {isEditorMounted && activeConfig && isRoutingGui && (
              <LazyBoundary>
                <GuiRouting editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
              </LazyBoundary>
            )}
            {isEditorMounted && activeConfig && isLogGui && (
              <LazyBoundary>
                <GuiLog editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
              </LazyBoundary>
            )}

            {!isConfigsLoading && (
              <div className={cn('absolute inset-0', isAnyGui && 'pointer-events-none invisible opacity-0')}>
                <LazyBoundary>
                  <CodeMirrorEditorLazy
                    ref={editorRef}
                    onContentChange={handleContentChange}
                    onValidationChange={handleValidationChange}
                    onReady={handleEditorReady}
                    onSave={() => saveCurrentConfig()}
                  />
                </LazyBoundary>
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 px-3 pb-3 sm:px-4 sm:pb-4">
            <div className="min-w-0 text-xs">
              {isConfigsLoading ? (
                <Skeleton className="h-4 w-30" />
              ) : validationState && activeConfig && isJson ? (
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-[13px] tracking-wide',
                    validationState.isValid ? 'text-green-400/90' : 'text-red-500'
                  )}
                >
                  {validationState.isValid ? <IconCheck size={15} /> : <IconX size={15} />}
                  {validationState.isValid
                    ? `${fileLanguage?.toUpperCase()} валиден`
                    : `Ошибка: ${validationState.error || 'Файл невалиден'}`}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {isConfigsLoading ? (
                <div className="flex gap-1.5">
                  {[120, 117, 96, 100].map((w) => (
                    <Skeleton key={w} className="h-9" style={{ width: w }} />
                  ))}
                </div>
              ) : (
                <>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button size="default" disabled={!canApply} className="btn-brand" onClick={() => saveAndApply()}>
                          <IconRefresh data-icon="inline-start" /> Применить
                        </Button>
                      }
                    />
                    <TooltipContent>Сохранить и перезапустить</TooltipContent>
                  </Tooltip>
                  <Button size="default" disabled={!canSave} onClick={() => saveCurrentConfig()}>
                    <IconDeviceFloppy data-icon="inline-start" /> Сохранить
                  </Button>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button variant="outline" disabled={!canFormat} onClick={() => editorRef.current?.format()}>
                          <IconCode data-icon="inline-start" /> <span className="hidden sm:inline">Формат</span>
                        </Button>
                      }
                    />
                    <TooltipContent>Форматировать файл</TooltipContent>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="outline">
                          <IconDotsFilled data-icon="inline-start" /> <span className="hidden sm:inline">Утилиты</span>
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" className="min-w-64">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Утилиты</DropdownMenuLabel>
                        <DropdownMenuItem onClick={onOpenImport}>
                          <IconLink /> Добавить подключение
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onOpenTemplate}>
                          <IconFileText /> Шаблоны конфигураций
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="whitespace-nowrap"
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest('[data-quick-backup]')) void quickBackup()
                            else onOpenBackups()
                          }}
                        >
                          <IconBox /> Бэкапы конфигураций
                          <Button
                            variant="outline"
                            size="icon-xs"
                            data-quick-backup
                            aria-label="Быстрый бэкап"
                            title="Быстрый бэкап"
                            tabIndex={-1}
                            className="ml-auto size-5 rounded-[min(var(--radius-md),6px)]"
                          >
                            <IconBoltFilled />
                          </Button>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onOpenGeoScan}>
                          <IconSearch /> Скан геофайлов
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onOpenRouteTest}>
                          <IconRoute /> Проверка маршрута
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      {isMobile ? (
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Полезные ссылки</DropdownMenuLabel>
                          {usefulLinks.map((link) => (
                            <DropdownMenuItem key={link.url} onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}>
                              <IconExternalLinkFilled /> {link.title}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      ) : (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <IconExternalLinkFilled /> Полезные ссылки
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="min-w-55">
                            {usefulLinks.map((link) => (
                              <DropdownMenuItem key={link.url} onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}>
                                <IconExternalLinkFilled /> {link.title}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
          </div>
        </div>
        <BackupsModalContainer onRefreshConfigs={refreshConfigsAndEditor} />
        {massConfirm && (
          <MassConfirmDialog
            open={!!massConfirm}
            onOpenChange={(open) => !open && setMassConfirm(null)}
            title={massConfirm.title}
            description={massConfirm.description}
            targets={massConfirm.targets}
            onConfirm={massConfirm.action}
          />
        )}
      </>
    </TooltipProvider>
  )
}

function errorToastText(body: string, fallbackPrefix = 'Ошибка') {
  return /^ошибк/i.test(body) ? body : `${fallbackPrefix}: ${body}`
}

function hasComments(content: string) {
  return /(?<!:)\/\/|\/\*[\s\S]*?\*\//.test(content) || /^\s*#/m.test(content)
}

function hasCriticalChanges(oldContent: string, newContent: string): boolean {
  try {
    const o = parseJsonc(oldContent)
    const n = parseJsonc(newContent)
    const clean = (arr: Record<string, unknown>[]) =>
      (arr || []).map((item) => Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'sniffing')))
    return JSON.stringify(clean(o?.inbounds)) !== JSON.stringify(clean(n?.inbounds))
  } catch {
    return false
  }
}
