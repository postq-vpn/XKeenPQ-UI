import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import * as React from 'react'

import { cn } from '@/lib/utils'

function Switch({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: 'sm' | 'default'
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'data-checked:bg-primary aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-200 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rd-action)] aria-invalid:ring-3 data-disabled:cursor-not-allowed data-disabled:opacity-50 data-unchecked:bg-[var(--rd-chip-hover)] data-[size=default]:h-[26px] data-[size=default]:w-[44px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:data-unchecked:bg-[var(--rd-chip-hover)]',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.2)] ring-0 transition-transform duration-200 group-data-[size=default]/switch:size-[22px] group-data-[size=default]/switch:translate-x-px group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[19px] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
