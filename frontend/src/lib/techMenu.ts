import { useEffect, useSyncExternalStore } from 'react'

/** «Техническое меню» в настройках скрыто, пока его не включат сочетанием Alt+Shift+T (⌥⇧T). */
const STORAGE_KEY = 'ui:techMenu'
const listeners = new Set<() => void>()

function read() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

let unlocked = read()

function setUnlocked(next: boolean) {
  unlocked = next
  try {
    if (next) localStorage.setItem(STORAGE_KEY, '1')
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* без хранилища выбор живёт до перезагрузки */
  }
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useTechMenuUnlocked = () => useSyncExternalStore(subscribe, () => unlocked)

/** Глобальное сочетание клавиш; `onToggle` получает новое состояние. По e.code — работает в любой раскладке. */
export function useTechMenuHotkey(onToggle: (unlocked: boolean) => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT')) return
      e.preventDefault()
      setUnlocked(!unlocked)
      onToggle(unlocked)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onToggle])
}
