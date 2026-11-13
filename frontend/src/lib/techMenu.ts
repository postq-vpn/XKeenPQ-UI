import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

/** «Техническое меню» в настройках скрыто, пока его не включат сочетанием Alt+Shift+T (⌥⇧T)
 * или, на телефоне, пятью нажатиями на знак в шапке экрана настроек. */
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

export const isTechMenuUnlocked = () => unlocked

const VERSION_KEY = 'ui:version'

/**
 * После установки или обновления панели (в том числе поверх оригинальной XKeen UI, где ключа
 * версии нет) меню снова скрыто. Возвращает true, если версия сменилась.
 */
export function lockTechMenuOnVersionChange(version: string) {
  let previous: string | null = null
  try {
    previous = localStorage.getItem(VERSION_KEY)
    localStorage.setItem(VERSION_KEY, version)
  } catch {
    return false
  }
  if (previous === version) return false
  if (unlocked) setUnlocked(false)
  return true
}

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

const TAPS_TO_TOGGLE = 5
/** Пауза между нажатиями, после которой счёт начинается заново. */
const TAP_GAP_MS = 800

/** Пять быстрых нажатий переключают меню (на телефоне нет сочетаний клавиш). Возвращает обработчик нажатия. */
export function useTechMenuTaps(onToggle: (unlocked: boolean) => void) {
  const taps = useRef({ count: 0, last: 0 })
  return useCallback(() => {
    const now = Date.now()
    const t = taps.current
    t.count = now - t.last > TAP_GAP_MS ? 1 : t.count + 1
    t.last = now
    if (t.count < TAPS_TO_TOGGLE) return
    t.count = 0
    setUnlocked(!unlocked)
    onToggle(unlocked)
  }, [onToggle])
}
