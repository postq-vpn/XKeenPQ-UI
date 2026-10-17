import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function repoSlug(url: string): string {
  let s = url.trim().replace(/\/+$/, '')
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  const i = s.indexOf('/')
  if (i > 0 && s.slice(0, i).includes('.')) s = s.slice(i + 1)
  return s.replace(/\.git$/i, '')
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* */
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none;z-index:-1;'
    const container = document.querySelector('[role="dialog"]') ?? document.body
    container.appendChild(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    const copied = document.execCommand('copy')
    textarea.remove()
    return copied
  } catch {
    return false
  }
}
