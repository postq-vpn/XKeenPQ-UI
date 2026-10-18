/**
 * Серверы авто-выбора и строки-разделители («⬇️ Тестовые серверы ⬇️») не показываются нигде
 * (backend: AUTO_SERVER_WORDS отбрасывает их при разборе подписки).
 */
const AUTO_SERVER_RE = /авто|auto|⬇|⬆/i

/** Принимает тег сервера (`подписка--Имя`) или имя. Тег подписки не может содержать «--». */
export const isAutoServer = (tag: string) => AUTO_SERVER_RE.test(tag.includes('--') ? tag.slice(tag.indexOf('--') + 2) : tag)

/** Проверяет и тег, и исходное имя: стрелки разделителей есть только в имени, в теге их нет. */
export const withoutAutoServers = <T extends { tag: string; name?: string }>(servers: T[] | undefined): T[] =>
  (servers ?? []).filter((s) => !isAutoServer(s.tag) && !(s.name && AUTO_SERVER_RE.test(s.name)))

/** Российские серверы самые медленные для обхода блокировок: в списках они внизу, под плашкой «Не рекомендуется». */
const NOT_RECOMMENDED_RE = /росси|russia/i

export const isNotRecommended = (s: { tag: string; name?: string }) => NOT_RECOMMENDED_RE.test(s.name ?? s.tag)

/** Разбивает список, сохраняя порядок внутри групп. */
export function splitRecommended<T extends { tag: string; name?: string }>(servers: T[]) {
  return {
    recommended: servers.filter((s) => !isNotRecommended(s)),
    notRecommended: servers.filter(isNotRecommended),
  }
}
