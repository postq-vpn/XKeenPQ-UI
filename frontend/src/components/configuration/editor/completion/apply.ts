import type { EditorState, TransactionSpec } from '@codemirror/state'
import type { ResolvedContext } from './jsonContext'
import type { SchemaNode } from './schema'

/** A pure edit description: one or more original-document-coordinate changes plus a cursor position. */
export interface Insertion {
  readonly changes: readonly { from: number; to: number; insert: string }[]
  readonly cursor: number
}

function single(from: number, to: number, insert: string): Insertion {
  return { changes: [{ from, to, insert }], cursor: from + insert.length }
}

/** `input.complete` is what makes CodeMirror consult `activateOnCompletion` after the edit. */
export function toTransactionSpec(insertion: Insertion): TransactionSpec {
  return { changes: insertion.changes, selection: { anchor: insertion.cursor }, userEvent: 'input.complete' }
}

/**
 * Builds the edit for accepting a JSON object key completion.
 * - bare token → `"key": `
 * - quoted, unterminated string → `key": ` (adds the missing closing quote)
 * - quoted, terminated, already followed by `:` → just replaces the inner text with `key`
 * - quoted, terminated, no `:` yet → swallows the closing quote and re-emits `key": ` (VS Code style)
 */
export function jsonKeyInsertion(state: EditorState, ctx: ResolvedContext, key: string): Insertion {
  if (!ctx.quoted) return single(ctx.from, ctx.to, `"${key}": `)

  const doc = state.doc
  const hasClosingQuote = ctx.to < doc.length && doc.sliceString(ctx.to, ctx.to + 1) === '"'
  if (!hasClosingQuote) return single(ctx.from, ctx.to, `${key}": `)

  const hasColonAfter = doc.sliceString(ctx.to + 1, ctx.to + 2) === ':'
  if (hasColonAfter) return single(ctx.from, ctx.to, key)

  return single(ctx.from, ctx.to + 1, `${key}": `)
}

/**
 * Builds the edit for accepting a JSON value completion. Booleans are always inserted bare
 * (consuming any quotes the user may have started); strings follow the same quoted/bare/
 * unterminated rules as `jsonKeyInsertion`.
 */
export function jsonValueInsertion(state: EditorState, ctx: ResolvedContext, value: string, node: SchemaNode): Insertion {
  const doc = state.doc
  if (node.type === 'boolean') {
    if (!ctx.quoted) return single(ctx.from, ctx.to, value)
    const hasClosingQuote = ctx.to < doc.length && doc.sliceString(ctx.to, ctx.to + 1) === '"'
    return single(ctx.from - 1, hasClosingQuote ? ctx.to + 1 : ctx.to, value)
  }
  if (!ctx.quoted) return single(ctx.from, ctx.to, `"${value}"`)
  const hasClosingQuote = ctx.to < doc.length && doc.sliceString(ctx.to, ctx.to + 1) === '"'
  if (!hasClosingQuote) return single(ctx.from, ctx.to, `${value}"`)
  return single(ctx.from, ctx.to, value)
}
