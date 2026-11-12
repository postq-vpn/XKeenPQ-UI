import * as React from 'react'

import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'file:text-foreground h-11 w-full min-w-0 rounded-[12px] border-2 border-transparent bg-[var(--rd-field)] px-3.5 py-1 text-[15px] text-[var(--rd-heading)] transition-colors duration-200 outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-[var(--rd-placeholder)] focus-visible:border-[var(--rd-action)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:text-[var(--rd-caption)] aria-invalid:border-[var(--rd-error)]',
        className
      )}
      {...props}
    />
  )
}

export { Input }
