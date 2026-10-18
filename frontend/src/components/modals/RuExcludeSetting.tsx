import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useEffect, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppActions } from '../../lib/store'

interface GeoIpSetResponse {
  success: boolean
  enabled: boolean
  available?: boolean
  /** XKeen умеет -gips/-dgips (форк jameszeroX 2.0+) */
  supported?: boolean
  error?: string
}

/**
 * Пункт установки XKeen «Исключить российские IP-адреса из проксирования» (GeoIPSET):
 * роутер вызывает `xkeen -gips` / `xkeen -dgips`, действует сразу, без перезапуска.
 */
export function RuExcludeSetting() {
  const { showToast } = useAppActions()
  const [state, setState] = useState<GeoIpSetResponse | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiCall<GeoIpSetResponse>('GET', 'geoipset')
      .then((res) => res.success && setState(res))
      .catch(() => {
        /* старый backend без этого адреса — пункт не показываем */
      })
  }, [])

  if (!state?.available) return null
  const supported = state.supported !== false

  async function toggle(enabled: boolean) {
    setBusy(true)
    try {
      const res = await apiCall<GeoIpSetResponse>('POST', 'geoipset', { enabled })
      setState((s) => (s ? { ...s, enabled: res.enabled } : s))
      if (!res.success) throw new Error(res.error || 'Не удалось изменить настройку')
      showToast(enabled ? 'Российские IP-адреса идут напрямую, мимо прокси' : 'Российские IP-адреса снова идут через прокси')
    } catch (e) {
      showToast(`Ошибка: ${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Separator className="my-3" />
      <p className="text-muted-foreground pt-4 pb-1 text-xs font-medium tracking-wider uppercase">Маршрутизация</p>
      <Field orientation="horizontal" className="px-0 py-3">
        <FieldContent>
          <FieldLabel htmlFor="ru-exclude">Исключить российские IP-адреса из проксирования</FieldLabel>
          <FieldDescription className="text-[13px]">
            {!supported
              ? 'Установленная версия XKeen этого не умеет. Нужен XKeen 2.0 или новее'
              : busy
                ? 'Роутер загружает списки, это может занять пару минут…'
                : 'IP-подсети России (GeoIPSET) идут напрямую. Списки обновляются вместе с геобазами XKeen'}
          </FieldDescription>
        </FieldContent>
        {busy ? (
          <Spinner className="size-4" />
        ) : (
          <Switch
            id="ru-exclude"
            checked={state.enabled}
            disabled={!supported}
            onCheckedChange={toggle}
            aria-label="Исключить российские IP-адреса"
          />
        )}
      </Field>
    </>
  )
}
