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
