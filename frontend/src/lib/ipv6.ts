import { apiCall } from './api'

/** Состояние IPv6 в основной сети (backend: ipv6.rs). `available` — роутер ответил. */
export interface Ipv6Status {
  available: boolean
  enabled?: boolean
}

/** Сообщает баннеру, что IPv6 включили или отключили. */
export const IPV6_CHANGED = 'ipv6-changed'

export async function loadIpv6Status(): Promise<Ipv6Status> {
  const res = await apiCall<{ success: boolean } & Ipv6Status>('GET', 'ipv6-status')
  return res.success ? res : { available: false }
}

export async function setIpv6(enabled: boolean) {
  const res = await apiCall<{ success: boolean; error?: string }>('POST', 'ipv6', { enabled })
  if (!res.success) throw new Error(res.error || 'Не удалось изменить IPv6')
  window.dispatchEvent(new Event(IPV6_CHANGED))
}
