/** Серверы авто-выбора не показываются нигде (backend: AUTO_SERVER_WORDS отбрасывает их при разборе подписки). */
const AUTO_SERVER_RE = /авто|auto/i

/** Принимает тег сервера (`подписка--Имя`) или имя. Тег подписки не может содержать «--». */
export const isAutoServer = (tag: string) => AUTO_SERVER_RE.test(tag.includes('--') ? tag.slice(tag.indexOf('--') + 2) : tag)

export const withoutAutoServers = <T extends { tag: string }>(servers: T[] | undefined): T[] =>
  (servers ?? []).filter((s) => !isAutoServer(s.tag))
