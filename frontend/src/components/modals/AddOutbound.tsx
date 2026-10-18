import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/utils'
import { IconCheck, IconCopy, IconLink, IconPlus, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import type { XraySubscription } from '../../lib/types'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { createXraySubscription } from './XraySubscriptions'

function highlightJson(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([[\]{}])/g, '<span style="color:#89ddff">$1</span>')
    .replace(/"([^"]+)"(\s*:)/g, '<span style="color:#7aa2f7">"$1"</span>$2')
    .replace(/:\s*"([^"]*)"/g, ': <span style="color:#9ece6a">"$1"</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:#ff9e64">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span style="color:#bb9af7">$1</span>')
}

type ApiResult = { success: boolean; error?: string; restart_error?: string }

const SUPPORTED_PROTOCOLS = ['ss://', 'vless://', 'vmess://', 'hysteria2://', 'hy2://', 'http://', 'https://', 'trojan://']

interface Props {
  onGenerate: (uri: string) => { content: string; type: string } | null
  onAddToConfig: (content: string, position: 'start' | 'end') => void
  /** Подписка Xray добавлена — родитель открывает выбор основного сервера. */
  onSubscriptionSaved: (sub: XraySubscription) => void
  /** Первый запуск без подписок: окно просит добавить подписку. */
  welcome?: boolean
}

export function ImportModal({ onGenerate, onAddToConfig, onSubscriptionSaved, welcome }: Props) {
  const { showToast, state } = useAppContext({ includeConfigs: true })
  const { modals, dispatch } = useModalContext()
  const [uri, setUri] = useState('')
  const [result, setResult] = useState<{ content: string; protocol: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const isValidUri = SUPPORTED_PROTOCOLS.some((p) => uri.toLowerCase().startsWith(p))

  function reset() {
    setResult(null)
    setAddError(null)
  }

  /**
   * Подписка добавляется в фоне, без окна настроек: загружаем её, чтобы взять название
   * и тег у провайдера, и сохраняем. Настройки потом меняются кнопкой ✎ у подписки.
   */
  async function addSubscription(draft: XraySubscription) {
    setAdding(true)
    try {
      const preview = await apiCall<ApiResult & { title?: string; suggested_tag?: string }>('POST', 'subscriptions/preview', {
        ...draft,
        auto_tag: true,
      })
      if (!preview.success) throw new Error(preview.error || 'Не удалось получить подписку')
      const res = await apiCall<ApiResult & { subscription?: XraySubscription }>('POST', 'subscriptions', {
        ...draft,
        tag: preview.suggested_tag || draft.tag,
        title: preview.title ?? '',
        auto_tag: true,
      })
      if (!res.success || !res.subscription) throw new Error(res.error || 'Не удалось добавить подписку')
      if (res.restart_error) showToast(`Не удалось перезапустить Xray: ${res.restart_error}`, 'error')
      close()
      onSubscriptionSaved(res.subscription)
    } catch (e: any) {
      setAddError(e.message)
    } finally {
      setAdding(false)
    }
  }

  function close() {
    dispatch({ type: 'SHOW_MODAL', modal: 'showImportModal', show: false })
    setTimeout(() => {
      setUri('')
      reset()
    }, 300)
  }

  function generate() {
    const trimmed = uri.trim()
    if (!trimmed) return
    reset()

    if (/^https?:\/\//i.test(trimmed)) {
      const existingTags = state.configs
        .map((c) => c.file.match(/04_outbounds(?:_sub)?\.([\w-]+)\.json$/)?.[1])
        .filter((t): t is string => !!t)
      void addSubscription(createXraySubscription(trimmed, existingTags))
      return
    }

    try {
      const generated = onGenerate(trimmed)
      if (!generated) return
      const protocol = trimmed.match(/^([a-zA-Z0-9+\-.]+):\/\//)?.[1]?.toUpperCase() ?? ''
      setResult({ content: generated.content, protocol })
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }

  async function copy() {
    if (!result) return
    const ok = await copyText(result.content)
    if (!ok) {
      showToast('Ошибка копирования', 'error')
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function addToConfig(position: 'start' | 'end') {
    if (!result) return
    onAddToConfig(result.content, position)
    close()
  }

  return (
    <TooltipProvider delayDuration={500}>
      <Dialog open={modals.showImportModal} onOpenChange={(open) => !open && close()}>
        <DialogContent className="flex max-h-[90dvh] w-auto! max-w-[min(90vw,900px)]! min-w-[min(90vw,480px)]! flex-col overflow-hidden">
          <DialogHeader className="shrink-0 pb-1">
            <DialogTitle className="flex items-center gap-2 pb-2">
              <IconLink size={24} className="text-chart-2" /> {welcome ? 'Добавьте подписку' : 'Добавить подключение'}
            </DialogTitle>
            <DialogDescription>
              {welcome
                ? 'Чтобы начать, вставьте ссылку на подписку https:// от вашего VPN-провайдера — серверы загрузятся и будут обновляться сами'
                : 'Вставьте ссылку в формате protocol:// или ссылку на подписку https://'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
            {result && (
              <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
                <div className="border-border bg-muted/30 flex w-full shrink-0 items-center justify-between border-b px-3 py-1">
                  <Badge className="bg-blue-500/10! px-2 pt-2.25 pb-2.5 text-[10px] tracking-wider text-blue-400">{result.protocol}</Badge>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button variant="ghost" size="icon-sm" onClick={copy}>
                          {copied ? <IconCheck className="text-green-500" /> : <IconCopy className="size-4.5" />}
                        </Button>
                      }
                    />
                    <TooltipContent side="left">Скопировать</TooltipContent>
                  </Tooltip>
                </div>

                <div className="bg-input-background min-h-0 flex-1 overflow-auto">
                  <pre
                    className="m-0 p-3 font-mono text-[13px] tracking-tight"
                    dangerouslySetInnerHTML={{
                      __html: highlightJson(result.content),
                    }}
                  />
                </div>

                <div className="border-border bg-muted/10 flex w-full shrink-0 gap-2 border-t p-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-w-0 flex-1 shrink gap-1.5 px-1.5 text-xs sm:px-2.5 max-sm:[&_svg]:hidden"
                    onClick={() => addToConfig('start')}
                  >
                    <IconPlus /> <span className="truncate">В начало</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-w-0 flex-1 shrink gap-1.5 px-1.5 text-xs sm:px-2.5 max-sm:[&_svg]:hidden"
                    onClick={() => addToConfig('end')}
                  >
                    <IconPlus /> <span className="truncate">В конец</span>
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-auto flex shrink-0 flex-col gap-3 pt-1">
              <InputGroup>
                <InputGroupInput
                  value={uri}
                  onChange={(e) => setUri(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && isValidUri && !adding && generate()}
                  disabled={adding}
                  placeholder="https://..."
                  className={uri ? 'pr-7' : ''}
                />
                <InputGroupAddon align="inline-end">
                  {uri && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => {
                        setUri('')
                        reset()
                      }}
                      className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
                    >
                      <IconX size={13} />
                    </Button>
                  )}
                </InputGroupAddon>
              </InputGroup>

              {addError && <p className="text-destructive text-xs break-words">{addError}</p>}

              <Button onClick={generate} disabled={!isValidUri || adding} className="w-full">
                {adding ? (
                  <>
                    <Spinner className="size-4" /> Загружаю подписку…
                  </>
                ) : /^https?:\/\//i.test(uri.trim()) || (welcome && !uri.trim()) ? (
                  'Продолжить'
                ) : (
                  'Сгенерировать'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
