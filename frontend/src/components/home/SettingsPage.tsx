import { SettingsPanel } from '../modals/Settings'

/** Настройки на телефоне — отдельный экран, а не окно поверх панели. «Назад» — в шапке (AppHeader). */
export function SettingsPage({ onOpenLog }: { onOpenLog: () => void }) {
  return (
    <section className="rd-card flex flex-col gap-(--rd-space-card) max-sm:p-4" aria-labelledby="settings-title">
      <h1 id="settings-title" className="rd-title">
        Настройки
      </h1>
      <SettingsPanel onOpenLog={onOpenLog} />
    </section>
  )
}
