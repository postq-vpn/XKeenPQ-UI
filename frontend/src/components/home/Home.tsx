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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useState } from 'react'
import type { XraySubscription } from '../../lib/types'
import { useSubscriptions } from '../../lib/useSubscriptions'
import { XraySubscriptionEditor } from '../modals/XraySubscriptions'
import { RouterBlock } from './RouterBlock'
import { SubscriptionBlock } from './SubscriptionBlock'
import { VpnBlock } from './VpnBlock'

/**
 * Главная: два блока. «Подписка» — откуда берутся серверы,
 * «VPN» — включён ли VPN и через какой сервер идёт трафик.
 */
export function Home({
  reloadKey,
  onLoaded,
  onChanged,
  onAddNew,
  onRefreshStatus,
}: {
  reloadKey: number
  onLoaded: (subs: XraySubscription[]) => void
  onChanged: () => void
  onAddNew: () => void
  onRefreshStatus: () => void
}) {
  const state = useSubscriptions({ reloadKey, onLoaded, onChanged })
  const [editing, setEditing] = useState<XraySubscription | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [deleting, setDeleting] = useState<XraySubscription | null>(null)

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-(--rd-space-grid) lg:grid-cols-[440px_minmax(0,1fr)] xl:grid-cols-[480px_minmax(0,1fr)]">
        {/* На телефоне обёртка растворяется в сетке, и «Роутер» встаёт после VPN. */}
        <div className="contents lg:sticky lg:top-[calc(56px+var(--rd-space-grid)+var(--rd-space-head))] lg:flex lg:flex-col lg:gap-(--rd-space-grid)">
          <SubscriptionBlock
            state={state}
            onAdd={onAddNew}
            onEdit={(sub) => {
              setEditing(sub)
              setEditorOpen(true)
            }}
            onDelete={setDeleting}
          />
          <div className="order-last lg:order-none">
            <RouterBlock />
          </div>
        </div>
        <VpnBlock state={state} onRefreshStatus={onRefreshStatus} onAddSubscription={onAddNew} />
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="flex h-[min(90dvh,760px)] w-full max-w-[min(calc(100%-2rem),600px)]! flex-col gap-(--rd-space-card) overflow-hidden">
          <DialogHeader className="shrink-0 gap-(--rd-space-title)">
            <DialogTitle>{editing?.title?.trim() || editing?.tag}</DialogTitle>
            <DialogDescription>Ссылка, расписание обновления и серверы подписки</DialogDescription>
          </DialogHeader>
          {editing && (
            <XraySubscriptionEditor
              key={editing.tag}
              initial={editing}
              isEdit
              onSaved={() => {
                setEditorOpen(false)
                void state.load(true)
                onChanged()
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить подписку «{deleting?.title?.trim() || deleting?.tag}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Файл с её серверами будет удалён, Xray перезапустится.{' '}
              {state.subs.length === 1 &&
                'Это последняя подписка: правила маршрутизации, которые на неё ссылаются, останутся без сервера — поправьте их вручную.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleting(null)}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const tag = deleting?.tag
                setDeleting(null)
                if (tag) void state.remove(tag)
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
