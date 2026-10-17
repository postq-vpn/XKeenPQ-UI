import type { EditorView } from '@codemirror/view'

export type EditorLanguage = 'json' | 'text'

/** Style spec accepted by `EditorView.theme` — pieces are merged into the single editor theme. */
export type ThemeSpec = Parameters<typeof EditorView.theme>[0]
