import { Select as SelectPrimitive } from '@base-ui/react/select'
import type { SelectRootProps, SelectRootChangeEventDetails } from '@base-ui/react/select'
import * as React from 'react'

import { cn } from '@/lib/utils'
import {
  Check as IconCheck,
  ChevronDown as IconChevronDown,
  ChevronUp as IconChevronUp,
  ChevronsUpDown as IconSelector,
} from 'lucide-react'

function Select({
  onValueChange,
  items,
  ...props
}: Omit<SelectRootProps<string>, 'onValueChange'> & {
  onValueChange?: (value: string, eventDetails: SelectRootChangeEventDetails) => void
}) {
  return (
    <SelectPrimitive.Root<string>
      data-slot="select"
      items={items}
      onValueChange={(value, details) => {
        if (value !== null) onValueChange?.(value, details)
      }}
      {...props}
    />
  )
}

function SelectGroup({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" className={cn('scroll-my-1 p-1', className)} {...props} />
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = 'default',
  popper = false,
  hideIcon = false,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'sm' | 'default'
  popper?: boolean
  hideIcon?: boolean
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      data-popper={popper ? '' : undefined}
      className={cn(
        "flex w-fit cursor-pointer items-center justify-between gap-1.5 rounded-[12px] border-2 border-transparent bg-[var(--rd-field)] py-2 pr-2.5 pl-3.5 text-[15px] whitespace-nowrap text-[var(--rd-heading)] transition-[background-color,border-color] duration-200 outline-none hover:bg-[var(--rd-chip-hover)] disabled:cursor-not-allowed disabled:opacity-50 data-popup-open:border-[var(--rd-action)] data-[size=default]:h-11 data-[size=sm]:h-10 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      {!hideIcon && (
        <SelectPrimitive.Icon>
          <IconSelector className="text-muted-foreground pointer-events-none size-4" />
        </SelectPrimitive.Icon>
      )}
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = 'popper',
  align = 'start',
  sideOffset = 6,
  side,
  alignOffset,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Popup> & {
  position?: 'item-aligned' | 'popper'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  side?: 'top' | 'bottom' | 'left' | 'right'
  alignOffset?: number
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        alignItemWithTrigger={position === 'item-aligned'}
        align={align}
        sideOffset={sideOffset}
        side={side}
        alignOffset={alignOffset}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'border-border text-popover-foreground relative z-50 max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-[12px] border bg-[var(--rd-surface)] p-1 shadow-[0_8px_32px_rgba(0,0,0,0.14)]',
            position === 'popper'
              ? 'data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-[side=bottom]:data-open:slide-in-from-top-2 data-[side=bottom]:data-closed:slide-out-to-top-2 data-[side=top]:data-open:slide-in-from-bottom-2 data-[side=top]:data-closed:slide-out-to-bottom-2 duration-200'
              : 'transition duration-200 ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0',
            className
          )}
          {...props}
        >
          <SelectScrollUpArrow />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownArrow />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn('text-muted-foreground px-2 py-1.5 text-xs', className)}
      {...props}
    />
  )
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-pointer items-center gap-2 rounded-[8px] py-2 pr-8 pl-2.5 text-[15px] outline-hidden select-none focus:bg-(--menu-active-bg) data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-(--menu-active-bg) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <IconCheck className="pointer-events-none size-3.5 stroke-3" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}

function SelectScrollUpArrow({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-arrow"
      className={cn(
        "inset-x-0 top-0 z-10 flex cursor-default items-center justify-center bg-gradient-to-b from-(--color-input-background) to-transparent py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <IconChevronUp />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownArrow({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-arrow"
      className={cn(
        "inset-x-0 bottom-0 z-10 flex cursor-default items-center justify-center bg-gradient-to-t from-(--color-input-background) to-transparent py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <IconChevronDown />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownArrow,
  SelectScrollUpArrow,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
