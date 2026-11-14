import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'

// Lottie «Liquid VPN route» — та же анимация, что прелоадер кабинета и postq-site
// (postq-cabinet: src/components/postq/Preloader.tsx). Знак собирается за кадры 0–107 и стоит до 153;
// пока идёт запуск, повторяем 0–153 — как прелоадер. Дальше в файле знак гаснет — это не нужно.
const LOOP: [number, number] = [0, 153]
/** Кадр собранного знака: на нём анимация заканчивается и сменяется статичным PostqMark. */
const ASSEMBLED = 107
/** Скорость как у прелоадера кабинета (PRELOADER_SPEED). */
const SPEED = 1.5
/** Если файл не загрузился или кадры не идут (вкладка в фоне) — не держим кнопку дольше этого. */
const FINISH_TIMEOUT_MS = 1500

export type LiquidMarkHandle = {
  /** Доиграть до собранного знака; промис выполняется, когда он собран (или сразу, если уже). */
  finish: () => Promise<void>
}

type Anim = {
  currentFrame: number
  firstFrame: number
  loop: boolean | number
  playSegments: (segment: [number, number], force: boolean) => void
  goToAndStop: (frame: number, isFrame: boolean) => void
  addEventListener: (name: string, cb: () => void) => void
  removeEventListener: (name: string, cb: () => void) => void
  destroy: () => void
}

/** Знак, который собирается по кругу, пока компонент на экране. Размер — через `className`
 * (пропорции файла 789×835), цвет — currentColor (globals.css, .rd-liquid-mark). */
export function LiquidMark({ className, ref }: { className?: string; ref?: Ref<LiquidMarkHandle> }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const animRef = useRef<Anim | null>(null)

  useImperativeHandle(ref, () => ({
    finish: () =>
      new Promise<void>((resolve) => {
        const a = animRef.current
        const timer = setTimeout(resolve, FINISH_TIMEOUT_MS)
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        if (!a) return done()
        // currentFrame — относительно начала текущего сегмента.
        const frame = a.firstFrame + a.currentFrame
        if (frame >= ASSEMBLED) {
          a.goToAndStop(ASSEMBLED, true)
          return done()
        }
        a.loop = false
        const onComplete = () => {
          a.removeEventListener('complete', onComplete)
          done()
        }
        a.addEventListener('complete', onComplete)
        a.playSegments([Math.floor(frame), ASSEMBLED], true)
      }),
  }))

  useEffect(() => {
    let destroyed = false
    const box = boxRef.current
    // Лёгкая сборка: только SVG, без выражений — этому файлу больше не нужно. Грузится при первом запуске.
    Promise.all([import('lottie-web/build/player/lottie_light'), import('@/assets/liquid-vpn-route.json')]).then(
      ([{ default: lottie }, { default: animationData }]) => {
        if (destroyed || !box) return
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
        const a = lottie.loadAnimation({ container: box, renderer: 'svg', loop: true, autoplay: false, animationData })
        a.setSpeed(SPEED)
        a.addEventListener('DOMLoaded', () => {
          if (reduce) a.goToAndStop(ASSEMBLED, true)
          else a.playSegments(LOOP, true)
        })
        animRef.current = a as unknown as Anim
      },
      () => {}
    )
    return () => {
      destroyed = true
      animRef.current?.destroy()
      animRef.current = null
    }
  }, [])

  return <div ref={boxRef} aria-hidden className={`rd-liquid-mark aspect-[789/835] ${className ?? ''}`} />
}
