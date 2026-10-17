import { jsonLanguage } from '@codemirror/lang-json'
import { ensureSyntaxTree, HighlightStyle, LanguageSupport } from '@codemirror/language'
import { Prec, RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { completionThemeSpec } from './completion'
import { searchThemeSpec } from './search/searchExtension'
import type { EditorLanguage } from './types'

const jsoncLang = jsonLanguage.configure({ dialect: 'jsonc' })

const commentDecoration = Decoration.mark({ attributes: { style: 'color: var(--cm-comment); font-style: italic' } })

function buildJsoncCommentDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const content = view.state.doc.toString()
  const commentRe = /(?<!:|\w)\/\/[^\n]*|\/\*[\s\S]*?\*\//g
  for (const match of content.matchAll(commentRe)) builder.add(match.index!, match.index! + match[0].length, commentDecoration)
  return builder.finish()
}

const jsoncCommentDecorator = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildJsoncCommentDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = buildJsoncCommentDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

const jsoncEagerParser = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      ensureSyntaxTree(view.state, view.state.doc.length, 1000)
    }
    update(update: ViewUpdate) {
      if (update.docChanged) ensureSyntaxTree(update.view.state, update.view.state.doc.length, 1000)
    }
  }
)

const jsoncExtension = new LanguageSupport(jsoncLang, [
  jsoncLang.data.of({ commentTokens: { line: '//' } }),
  jsoncEagerParser,
  Prec.highest(jsoncCommentDecorator),
])

export function getLanguageExtension(language: EditorLanguage): Extension {
  if (language === 'json') return jsoncExtension
  return []
}

export const editorHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--cm-property)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--cm-string)' },
  { tag: tags.number, color: 'var(--cm-number)' },
  { tag: [tags.bool, tags.null, tags.atom], color: 'var(--cm-bool)' },
  { tag: tags.keyword, color: 'var(--cm-bool)' },
  { tag: tags.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: tags.labelName, color: 'var(--cm-property)' },
  { tag: tags.typeName, color: 'var(--cm-property)' },
  { tag: tags.punctuation, color: 'var(--cm-punctuation)' },
  { tag: tags.operator, color: 'var(--cm-punctuation)' },
])

export const editorTheme = (isMobile: boolean, isDarkTheme: boolean) =>
  EditorView.theme(
    {
      '&': {
        height: '100%',
        '--cm-bg': isDarkTheme ? '#07030f' : '#ffffff',
        '--cm-panel-bg': isDarkTheme ? '#0e0620' : '#f8f8f8',
        '--cm-fg': isDarkTheme ? '#ece4f7' : '#212023',
        '--cm-caret': isDarkTheme ? '#f0b3e6' : '#ff2181',
        '--cm-selection': isDarkTheme ? 'rgba(207, 0, 163, 0.32)' : '#ffd6e8',
        '--cm-selection-match': isDarkTheme ? 'rgba(207, 0, 163, 0.18)' : '#ffe9f2',
        '--cm-gutter': isDarkTheme ? '#4a3d63' : '#a1a1aa',
        '--cm-gutter-active': isDarkTheme ? '#d7c2f0' : '#52525b',
        '--cm-fold': isDarkTheme ? '#6f6189' : '#77757a',
        '--cm-fold-placeholder-bg': isDarkTheme ? 'rgba(207, 0, 163, 0.15)' : '#fff0f6',
        '--cm-fold-placeholder-border': isDarkTheme ? '#e592d3' : '#ff94c3',
        '--cm-fold-placeholder-text': isDarkTheme ? '#e592d3' : '#c40f60',
        '--cm-border': isDarkTheme ? 'rgba(255, 255, 255, 0.09)' : '#ececee',
        '--cm-property': isDarkTheme ? '#e592d3' : '#c40f60',
        '--cm-string': isDarkTheme ? '#9ece6a' : '#15803d',
        '--cm-number': isDarkTheme ? '#ff9e64' : '#ea580c',
        '--cm-bool': isDarkTheme ? '#bb9af7' : '#7c3aed',
        '--cm-comment': isDarkTheme ? '#6f6189' : '#77757a',
        '--cm-punctuation': isDarkTheme ? '#b8a6d9' : '#77757a',
        backgroundColor: 'var(--cm-bg)',
        color: 'var(--cm-fg)',
        fontSize: isMobile ? '13px' : '14px',
      },
      '.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.5',
        scrollbarWidth: 'thin',
        backgroundColor: 'var(--cm-bg)',
      },
      '.cm-content': {
        caretColor: 'var(--cm-caret)',
        padding: '8px 0 16px 0',
        fontFeatureSettings: '"calt" 0',
      },
      '.cm-line': { padding: '0 4px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cm-caret)' },
      '.cm-selectionBackground': { backgroundColor: 'var(--cm-selection) !important' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--cm-selection) !important' },
      '.cm-selectionMatch, .cm-searchMatch': { backgroundColor: 'var(--cm-selection-match)' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--cm-gutter-active)' },
      '.cm-lineNumbers': { minWidth: '3ch !important' },
      '.cm-lineNumbers .cm-gutterElement': { minWidth: '3ch !important', textAlign: 'right' },
      '.cm-gutters': {
        display: isMobile ? 'none' : 'flex',
        backgroundColor: 'var(--cm-bg)',
        color: 'var(--cm-gutter)',
        border: 'none',
      },
      '.cm-foldGutter': { width: '14px', cursor: 'pointer', color: 'var(--cm-fold)' },
      '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--cm-gutter-active)' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--cm-fold-placeholder-bg)',
        borderColor: 'var(--cm-fold-placeholder-border)',
        color: 'var(--cm-fold-placeholder-text)',
      },
      '.cm-diagnosticText': { fontFamily: 'var(--font-mono)' },
      '.cm-panels': {
        backgroundColor: 'var(--cm-panel-bg)',
        color: 'var(--cm-fg)',
        zIndex: 1,
      },
      '.cm-tooltip': { backgroundColor: 'var(--cm-panel-bg)', color: 'var(--cm-fg)', border: '1px solid var(--cm-border)', zIndex: 40 },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--menu-active-bg)',
        color: 'var(--color-blue-400)',
        fontWeight: '600',
      },
      ...searchThemeSpec(isDarkTheme),
      ...completionThemeSpec,
    },
    { dark: isDarkTheme }
  )
