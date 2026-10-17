import type { Diagnostic } from '@codemirror/lint'
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { EditorLanguage } from './types'

export interface ValidationResult {
  diagnostics: Diagnostic[]
  isValid: boolean
  error?: string
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function offsetToLine(content: string, offset: number) {
  return content.slice(0, clamp(offset, 0, content.length)).split('\n').length
}

function validateJson(content: string): ValidationResult {
  const errors: ParseError[] = []
  parseJsonc(content, errors, {
    disallowComments: false,
  })
  if (!errors.length) return { diagnostics: [], isValid: true }

  const first = errors[0]
  const from = clamp(first.offset, 0, content.length)
  const parsedTo = clamp(first.offset + Math.max(first.length, 1), 0, content.length)
  const to = parsedTo > from ? parsedTo : from
  const message = `${printParseErrorCode(first.error)
    .replace(/([A-Z])/g, ' $1')
    .trim()} [строка ${offsetToLine(content, from)}]`
    .replace(/([A-Z])/g, ' $1')
    .trim()
  return {
    diagnostics: [{ from, to, severity: 'error', message }],
    isValid: false,
    error: message,
  }
}

export function validateByLanguage(content: string, language: EditorLanguage): ValidationResult {
  if (language === 'json') return validateJson(content)
  return { diagnostics: [], isValid: true }
}
