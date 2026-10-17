import { Switch } from '@/components/ui/switch'
import { IconEyeOff } from '@tabler/icons-react'
import { useSyncExternalStore } from 'react'

/** Служебные серверы подписок (российские, авто-выбор, «обход»), которые по умолчанию не показываем. Кириллица и латиница. */
const HIDDEN_SERVER_RE = /россия|авто|обход|russia|auto|bypass/i

export const isHiddenServer = (name: string) => HIDDEN_SERVER_RE.test(name)

const STORAGE_KEY = 'subscriptions:showHiddenServers'
const listeners = new Set<() => void>()

function readShowHidden() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

let showHidden = readShowHidden()

function setShowHidden(value: boolean) {
  showHidden = value
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    /* без хранилища настройка живёт до перезагрузки */
  }
  listeners.forEach((l) => l())
}

/** Общий для всех списков серверов флаг «показывать скрытые». */
export function useShowHiddenServers(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => showHidden
  )
  return [value, setShowHidden]
}

/**
 * Оставляет видимые серверы. `keep` — теги, которые показываем всегда (выбранный/активный сервер),
 * чтобы текущий выбор не пропадал из списка.
 */
export function filterHiddenServers<T extends { tag: string }>(
  servers: T[],
  nameOf: (s: T) => string,
  show: boolean,
  keep: string[] = []
) {
  const hidden = servers.filter((s) => isHiddenServer(nameOf(s)) && !keep.includes(s.tag)).length
  return { visible: show ? servers : servers.filter((s) => !isHiddenServer(nameOf(s)) || keep.includes(s.tag)), hidden }
}

/** Тумблер «Скрытые (N)»: показывается, только если есть что скрывать. */
export function HiddenServersToggle({ count, show, onChange }: { count: number; show: boolean; onChange: (v: boolean) => void }) {
  if (count === 0) return null
  return (
    <label
      className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-xs select-none"
      title="Серверы со словами «Россия», «авто», «обход» (и russia, auto, bypass) в названии"
      onClick={(e) => e.stopPropagation()}
    >
      <IconEyeOff size={14} />
      Скрытые ({count})
      <Switch size="sm" checked={show} onCheckedChange={onChange} />
    </label>
  )
}
