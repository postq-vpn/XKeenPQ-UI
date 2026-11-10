import { apiCall } from './api'

/**
 * Состояние IPv6 в основной сети (backend: ipv6.rs). `ask` — показать окно про отключённый IPv6,
 * `notice` — баннер: панель отключила IPv6, и он до сих пор выключен.
 */
export interface Ipv6Status {
  enabled?: boolean
  ask: boolean
  notice?: boolean
}

/** Сообщает окну и баннеру, что IPv6 включили или выбор сохранён. */
export const IPV6_CHANGED = 'ipv6-changed'

export async function loadIpv6Status(): Promise<Ipv6Status> {
  const res = await apiCall<{ success: boolean } & Ipv6Status>('GET', 'ipv6-status')
  return res.success ? res : { ask: false }
}

export async function setIpv6(enabled: boolean) {
  const res = await apiCall<{ success: boolean; error?: string }>('POST', 'ipv6', { enabled })
  if (!res.success) throw new Error(res.error || 'Не удалось изменить IPv6')
  window.dispatchEvent(new Event(IPV6_CHANGED))
}

export async function acceptIpv6Off() {
  const res = await apiCall<{ success: boolean; error?: string }>('POST', 'ipv6/accept')
  if (!res.success) throw new Error(res.error || 'Не удалось сохранить выбор')
  window.dispatchEvent(new Event(IPV6_CHANGED))
}
