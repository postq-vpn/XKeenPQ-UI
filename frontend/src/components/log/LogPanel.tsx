import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ChevronDown as IconChevronDown,
  Download as IconDownload,
  File as IconFile,
  Filter as IconFilter,
  Maximize2 as IconMaximize,
  Minimize2 as IconMinimize,
  Plus as IconPlus,
  Trash2 as IconTrash,
  X as IconX,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { LOCAL_ROUTER_ID, isRouterSelectable, routerId } from '../../lib/multi-routers/model'
import { useRoutersStore } from '../../lib/multi-routers/store'
import { useSettings } from '../../lib/store'
import { cn } from '../../lib/utils'
import type { WsMessage } from '../../lib/websocket'
import { useWebSocket } from '../../lib/websocket'
import { AddRouterDialog } from './multi-routers/AddRouterDialog'
import { RoutersListPanel } from './multi-routers/RoutersListPanel'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group'

const LOG_FILES = ['error.log', 'access.log']
const MAX_LINES = 1000

interface LogPanelProps {
  /** Блок главной страницы: растягивается на всю высоту вместо полосы внизу. */
  asPage?: boolean
  /** Элементы справа в заголовке (меню «Технические файлы»). */
  headerExtra?: ReactNode
}

export function LogPanel({ asPage, headerExtra }: LogPanelProps = {}) {
  const timezone = useSettings((s) => s.timezone)
  const multiRouter = useSettings((s) => s.multiRouter)
  const routers = useRoutersStore((s) => s.routers)
  const applyTargets = useRoutersStore((s) => s.applyTargets)
  const online = useRoutersStore((s) => s.online)
  const auth = useRoutersStore((s) => s.auth)
  const setApplyTargets = useRoutersStore((s) => s.setApplyTargets)
  const [panelTab, setPanelTab] = useState<'journal' | 'routers'>('journal')
  const [addRouterOpen, setAddRouterOpen] = useState(false)
  useEffect(() => {
    if (!multiRouter && panelTab === 'routers') setPanelTab('journal')
  }, [multiRouter, panelTab])
  const allRouterIds = [LOCAL_ROUTER_ID, ...routers.map(routerId)]
  const selectableRouterIds = allRouterIds.filter((id) => isRouterSelectable(id, online, auth))
  const allRoutersSelected = selectableRouterIds.length > 0 && selectableRouterIds.every((id) => applyTargets.includes(id))
  const showSelectAllRouters = multiRouter && panelTab === 'routers' && routers.length > 0
  const showRoutersToolbar = multiRouter && panelTab === 'routers'
  const [filter, setFilter] = useState('')
  const [currentFile, setCurrentFile] = useState('error.log')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)
  const [isEmpty, setIsEmpty] = useState(true)

  const logRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const isFullscreenRef = useRef(false)
  const isAnimatingRef = useRef(false)
  const filterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoScrollRef = useRef(true)
  const linesRef = useRef<string[]>([])
  const scrollTickingRef = useRef(false)

  useEffect(() => {
    return () => {
      if (filterTimerRef.current) clearTimeout(filterTimerRef.current)
      document.body.style.overflow = ''
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const trimToCap = useCallback(() => {
    const el = logRef.current
    if (!el) return
    const overflow = linesRef.current.length - MAX_LINES
    if (overflow <= 0) return
    linesRef.current.splice(0, overflow)
    for (let i = 0; i < overflow && el.firstChild; i++) {
      el.removeChild(el.firstChild)
    }
  }, [])

  const renderAll = useCallback((lines: string[]) => {
    const el = logRef.current
    if (!el) return

    const capped = lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines
    linesRef.current = capped
    const hasLines = capped.length > 0

    setIsEmpty(!hasLines)
    el.innerHTML = hasLines ? capped.join('') : ''

    if (hasLines && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  const appendLines = useCallback(
    (newLines: string[]) => {
      if (newLines.length === 0) return
      const el = logRef.current
      if (!el) return

      setIsEmpty(false)
      linesRef.current.push(...newLines)
      el.insertAdjacentHTML('beforeend', newLines.join(''))

      if (autoScrollRef.current) {
        trimToCap()
        el.scrollTop = el.scrollHeight
      }
    },
    [trimToCap]
  )

  const handleMessage = useCallback(
    (data: WsMessage) => {
      if (data.error) {
        renderAll([`<div style="color:#ef4444">ERROR: ${data.error}</div>`])
        return
      }
      if (data.type === 'initial' || data.type === 'filtered') {
        renderAll(data.lines || [])
        return
      }
      if (data.type === 'clear') {
        renderAll([])
        return
      }
      if (data.type === 'append' && data.content) {
        appendLines(data.content.split('\n').filter((l) => l.trim()))
      }
    },
    [renderAll, appendLines]
  )

  const ws = useWebSocket(handleMessage)

  useEffect(() => {
    ws.reload(filter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timezone])

  function switchFile(filename: string) {
    if (filename === currentFile) return
    setCurrentFile(filename)
    renderAll([])
    ws.switchFile(filename)
  }

  function handleFilterChange(value: string) {
    setFilter(value)
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current)
    filterTimerRef.current = setTimeout(() => ws.applyFilter(value), 100)
  }

  const checkScrollPosition = useCallback(() => {
    const el = logRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.clientHeight <= el.scrollTop + 40
    autoScrollRef.current = atBottom
    setShowScrollBtn(!atBottom)
  }, [])

  function handleScroll() {
    if (isAnimating || scrollTickingRef.current) return
    scrollTickingRef.current = true
    requestAnimationFrame(() => {
      checkScrollPosition()
      scrollTickingRef.current = false
    })
  }

  function handleScrollToBottom() {
    autoScrollRef.current = true
    setShowScrollBtn(false)
    trimToCap()
    scrollToBottom()
  }

  function handleLogClick(e: React.MouseEvent<HTMLDivElement>) {
    const badge = (e.target as HTMLElement).closest('span')
    if (!badge?.textContent) return
    const level = badge.textContent
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current)
    setFilter(level)
    ws.applyFilter(level)
  }

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) {
      setIsFullscreen((v) => {
        const next = !v
        isFullscreenRef.current = next
        document.body.style.overflow = next ? 'hidden' : ''
        return next
      })
      return
    }

    const first = el.getBoundingClientRect()
    const nextFullscreen = !isFullscreenRef.current
    isFullscreenRef.current = nextFullscreen

    if (nextFullscreen) document.body.style.overflow = 'hidden'

    const backdrop = backdropRef.current
    if (backdrop) {
      if (!isAnimatingRef.current) {
        backdrop.style.transition = 'none'
        backdrop.style.opacity = nextFullscreen ? '0' : '1'
      }
      requestAnimationFrame(() => {
        backdrop.style.transition = 'opacity 0.2s'
        backdrop.style.opacity = nextFullscreen ? '1' : '0'
      })
    }

    el.style.transition = 'none'

    flushSync(() => {
      setIsFullscreen(nextFullscreen)
      setIsAnimating(true)
    })

    isAnimatingRef.current = true

    el.style.willChange = 'transform, border-radius'
    el.style.transform = ''
    const last = el.getBoundingClientRect()

    const dx = first.left - last.left
    const dy = first.top - last.top
    const scaleX = first.width / last.width
    const scaleY = first.height / last.height

    el.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`
    el.style.transformOrigin = 'top left'

    void el.offsetHeight

    el.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)'
    el.style.transform = ''

    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== 'transform') return
      el.removeEventListener('transitionend', onTransitionEnd)

      if (!isFullscreenRef.current) {
        document.body.style.overflow = ''
      }

      el.style.transition = ''
      el.style.transformOrigin = ''
      el.style.willChange = ''
      isAnimatingRef.current = false
      setIsAnimating(false)
      checkScrollPosition()
    }

    if ((el as any)._onTransitionEnd) {
      el.removeEventListener('transitionend', (el as any)._onTransitionEnd)
    }
    ;(el as any)._onTransitionEnd = onTransitionEnd
    el.addEventListener('transitionend', onTransitionEnd)
  }, [checkScrollPosition])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === 'Escape' && isFullscreenRef.current) {
        toggleFullscreen()
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.code !== 'KeyA') return
      const el = logRef.current
      if (el && (el.contains(document.activeElement) || document.activeElement === el)) {
        e.preventDefault()
        window.getSelection()?.selectAllChildren(el)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [toggleFullscreen])

  useEffect(() => {
    const el = logRef.current
    if (!el) return

    let rTicking = false
    const ro = new ResizeObserver(() => {
      if (autoScrollRef.current && !rTicking) {
        rTicking = true
        requestAnimationFrame(() => {
          scrollToBottom()
          rTicking = false
        })
      }
    })

    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollToBottom])

  return (
    <TooltipProvider delayDuration={500}>
      <div className={cn('relative w-full', asPage ? 'min-h-[70dvh] flex-1' : 'h-70 pb-3 md:shrink-0')}>
        <div
          ref={backdropRef}
          className="fixed inset-0 z-40 bg-black/50 opacity-0"
          style={{
            display: isFullscreen || isAnimating ? 'block' : 'none',
          }}
          onClick={toggleFullscreen}
        />

        <div
          ref={containerRef}
          className={cn(
            'rd-card flex flex-col overflow-hidden',
            isFullscreen ? 'fixed inset-x-3 bottom-3 z-50 shadow-2xl sm:inset-x-4 sm:mx-auto sm:max-w-400' : 'absolute inset-0 z-10 w-full'
          )}
          style={{
            height: isFullscreen ? 'calc(100dvh - 1.25rem)' : '100%',
          }}
        >
          <Tabs
            value={panelTab}
            onValueChange={(v) => setPanelTab(v as 'journal' | 'routers')}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="flex shrink-0 flex-col justify-between gap-(--rd-space-group) sm:flex-row sm:items-center">
              {multiRouter ? (
                <TabsList variant="line" className="h-auto gap-3 bg-transparent p-0">
                  <TabsTrigger value="journal" className="rd-title p-0">
                    Журнал Xray
                  </TabsTrigger>
                  <TabsTrigger value="routers" className="rd-title p-0">
                    Роутеры
                  </TabsTrigger>
                </TabsList>
              ) : (
                <h2 className="rd-title select-none">Журнал Xray</h2>
              )}
              {panelTab === 'journal' && (
                <div className="flex flex-wrap items-center gap-(--rd-space-item)">
                  <div className="relative flex min-w-30 flex-1 items-center sm:flex-none">
                    <InputGroup className="w-full sm:w-52">
                      <InputGroupInput
                        placeholder="Фильтр"
                        className="right-2"
                        value={filter}
                        onChange={(e) => handleFilterChange(e.target.value)}
                      />
                      <InputGroupAddon>
                        <IconFilter />
                      </InputGroupAddon>
                      <InputGroupAddon align="inline-end">
                        {filter && (
                          <InputGroupButton
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => {
                              if (filterTimerRef.current) clearTimeout(filterTimerRef.current)
                              setFilter('')
                              ws.applyFilter('')
                            }}
                            className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
                          >
                            <IconX className="size-3.25" />
                          </InputGroupButton>
                        )}
                      </InputGroupAddon>
                    </InputGroup>
                  </div>
                  <div role="tablist" aria-label="Файл журнала" className="flex h-11 gap-1 rounded-[12px] bg-[var(--rd-field)] p-1">
                    {LOG_FILES.map((f) => (
                      <button
                        key={f}
                        type="button"
                        role="tab"
                        aria-selected={currentFile === f}
                        onClick={() => currentFile !== f && switchFile(f)}
                        className={cn(
                          'cursor-pointer rounded-[9px] px-3 text-[15px] font-medium transition-colors',
                          currentFile === f
                            ? 'bg-[var(--rd-surface)] text-[var(--rd-heading)] shadow-[0_2px_10px_rgba(0,0,0,0.06)] dark:bg-[var(--rd-chip-hover)]'
                            : 'text-[var(--rd-caption)] hover:text-[var(--rd-heading)]'
                        )}
                      >
                        {f.replace('.log', '')}
                      </button>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center gap-(--rd-space-item) sm:ml-0">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="outline"
                            size="icon"
                            render={<a href={`/api/logs/download?file=${encodeURIComponent(currentFile)}`} download />}
                            nativeButton={false}
                          >
                            <IconDownload />
                          </Button>
                        }
                      />
                      <TooltipContent>Скачать {currentFile}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="outline" size="icon" className="hover:text-destructive" onClick={() => ws.clearLog()}>
                            <IconTrash />
                          </Button>
                        }
                      />
                      <TooltipContent>Очистить лог</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="outline" size="icon" onClick={toggleFullscreen}>
                            {isFullscreen ? <IconMinimize /> : <IconMaximize />}
                          </Button>
                        }
                      />
                      <TooltipContent>{isFullscreen ? 'Свернуть' : 'Развернуть'}</TooltipContent>
                    </Tooltip>
                    {headerExtra}
                  </div>
                </div>
              )}
              {showRoutersToolbar && (
                <div className="flex items-center gap-3">
                  {showSelectAllRouters && (
                    <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={allRoutersSelected}
                        disabled={selectableRouterIds.length === 0}
                        onCheckedChange={(checked) => setApplyTargets(checked === true ? selectableRouterIds : [])}
                        aria-label="Выбрать все"
                      />
                      Выбрать все
                    </label>
                  )}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button variant="outline" size="icon" onClick={() => setAddRouterOpen(true)}>
                          <IconPlus />
                        </Button>
                      }
                    />
                    <TooltipContent>Добавить</TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>

            <TabsContent
              value="journal"
              forceMount={multiRouter || undefined}
              className="relative mt-(--rd-space-group) min-h-0 flex-1 data-[state=inactive]:hidden"
            >
              <div className="absolute inset-0 overflow-hidden rounded-[var(--rd-radius-sm)] bg-[var(--rd-field)]">
                {isEmpty && (
                  <Empty className="h-full gap-0">
                    <EmptyMedia variant="icon" className="size-8.5">
                      <IconFile className="text-muted-foreground size-5" />
                    </EmptyMedia>
                    <EmptyTitle className="rd-meta">Журнал пуст</EmptyTitle>
                  </Empty>
                )}
                <div
                  ref={logRef}
                  tabIndex={0}
                  className={cn(
                    'scrollbar-width:thin h-full overflow-y-auto px-4 py-3 font-mono text-[13px] leading-[1.7] wrap-anywhere text-[var(--rd-heading)] contain-content',
                    isAnimating && 'pointer-events-none'
                  )}
                  onScroll={handleScroll}
                  onClick={handleLogClick}
                />
              </div>

              {showScrollBtn && !isAnimating && (
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="absolute right-4 bottom-4 z-10 rounded-full bg-[var(--rd-surface)] shadow-[0_8px_24px_rgba(0,0,0,0.15)]"
                  onClick={handleScrollToBottom}
                >
                  <IconChevronDown size={14} />
                </Button>
              )}
            </TabsContent>

            <TabsContent value="routers" className="relative mt-(--rd-space-group) min-h-0 flex-1">
              {multiRouter && (
                <div className="absolute inset-0 overflow-hidden rounded-[var(--rd-radius-sm)] bg-[var(--rd-field)]">
                  <RoutersListPanel />
                </div>
              )}
            </TabsContent>
          </Tabs>
          <AddRouterDialog open={addRouterOpen} onOpenChange={setAddRouterOpen} />
        </div>
      </div>
    </TooltipProvider>
  )
}
