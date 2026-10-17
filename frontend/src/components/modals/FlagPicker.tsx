import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { IconFlag, IconSearch } from '@tabler/icons-react'
import { useState } from 'react'

const FLAG_OPTIONS: { emoji: string; label: string; en: string }[] = [
  { emoji: '🇷🇺', label: 'Россия', en: 'Russia' },
  { emoji: '🇺🇦', label: 'Украина', en: 'Ukraine' },
  { emoji: '🇧🇾', label: 'Беларусь', en: 'Belarus' },
  { emoji: '🇰🇿', label: 'Казахстан', en: 'Kazakhstan' },
  { emoji: '🇺🇿', label: 'Узбекистан', en: 'Uzbekistan' },
  { emoji: '🇬🇪', label: 'Грузия', en: 'Georgia' },
  { emoji: '🇦🇲', label: 'Армения', en: 'Armenia' },
  { emoji: '🇦🇿', label: 'Азербайджан', en: 'Azerbaijan' },
  { emoji: '🇫🇮', label: 'Финляндия', en: 'Finland' },
  { emoji: '🇸🇪', label: 'Швеция', en: 'Sweden' },
  { emoji: '🇳🇴', label: 'Норвегия', en: 'Norway' },
  { emoji: '🇩🇰', label: 'Дания', en: 'Denmark' },
  { emoji: '🇮🇸', label: 'Исландия', en: 'Iceland' },
  { emoji: '🇩🇪', label: 'Германия', en: 'Germany' },
  { emoji: '🇫🇷', label: 'Франция', en: 'France' },
  { emoji: '🇳🇱', label: 'Нидерланды', en: 'Netherlands' },
  { emoji: '🇧🇪', label: 'Бельгия', en: 'Belgium' },
  { emoji: '🇨🇭', label: 'Швейцария', en: 'Switzerland' },
  { emoji: '🇦🇹', label: 'Австрия', en: 'Austria' },
  { emoji: '🇵🇱', label: 'Польша', en: 'Poland' },
  { emoji: '🇨🇿', label: 'Чехия', en: 'Czechia' },
  { emoji: '🇸🇰', label: 'Словакия', en: 'Slovakia' },
  { emoji: '🇭🇺', label: 'Венгрия', en: 'Hungary' },
  { emoji: '🇷🇴', label: 'Румыния', en: 'Romania' },
  { emoji: '🇧🇬', label: 'Болгария', en: 'Bulgaria' },
  { emoji: '🇬🇷', label: 'Греция', en: 'Greece' },
  { emoji: '🇷🇸', label: 'Сербия', en: 'Serbia' },
  { emoji: '🇭🇷', label: 'Хорватия', en: 'Croatia' },
  { emoji: '🇸🇮', label: 'Словения', en: 'Slovenia' },
  { emoji: '🇮🇹', label: 'Италия', en: 'Italy' },
  { emoji: '🇪🇸', label: 'Испания', en: 'Spain' },
  { emoji: '🇵🇹', label: 'Португалия', en: 'Portugal' },
  { emoji: '🇮🇪', label: 'Ирландия', en: 'Ireland' },
  { emoji: '🇬🇧', label: 'Великобритания', en: 'United Kingdom' },
  { emoji: '🇪🇪', label: 'Эстония', en: 'Estonia' },
  { emoji: '🇱🇻', label: 'Латвия', en: 'Latvia' },
  { emoji: '🇱🇹', label: 'Литва', en: 'Lithuania' },
  { emoji: '🇺🇸', label: 'США', en: 'United States' },
  { emoji: '🇨🇦', label: 'Канада', en: 'Canada' },
  { emoji: '🇧🇷', label: 'Бразилия', en: 'Brazil' },
  { emoji: '🇦🇷', label: 'Аргентина', en: 'Argentina' },
  { emoji: '🇯🇵', label: 'Япония', en: 'Japan' },
  { emoji: '🇰🇷', label: 'Южная Корея', en: 'South Korea' },
  { emoji: '🇨🇳', label: 'Китай', en: 'China' },
  { emoji: '🇸🇬', label: 'Сингапур', en: 'Singapore' },
  { emoji: '🇭🇰', label: 'Гонконг', en: 'Hong Kong' },
  { emoji: '🇹🇼', label: 'Тайвань', en: 'Taiwan' },
  { emoji: '🇹🇷', label: 'Турция', en: 'Turkey' },
  { emoji: '🇮🇱', label: 'Израиль', en: 'Israel' },
  { emoji: '🇦🇪', label: 'ОАЭ', en: 'UAE' },
  { emoji: '🇮🇳', label: 'Индия', en: 'India' },
  { emoji: '🇦🇺', label: 'Австралия', en: 'Australia' },
  { emoji: '🇳🇿', label: 'Новая Зеландия', en: 'New Zealand' },
  { emoji: '🇿🇦', label: 'ЮАР', en: 'South Africa' },
]

function appendFlags(value: string, flags: string[]): string {
  const next = flags.filter((flag) => !value.includes(flag))
  if (!next.length) return value
  const joined = next.join('|')
  if (!value.trim()) return joined
  return value.endsWith('|') ? value + joined : `${value}|${joined}`
}

export function FlagPicker({ value, onAdd }: { value: string; onAdd: (next: string) => void }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')

  const search = query.trim().toLowerCase()
  const visibleFlags = search
    ? FLAG_OPTIONS.filter((flag) => flag.label.toLowerCase().includes(search) || flag.en.toLowerCase().includes(search))
    : FLAG_OPTIONS

  function toggleFlag(flag: string) {
    setSelected((prev) => (prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]))
  }

  function confirm() {
    onAdd(appendFlags(value, selected))
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSelected(FLAG_OPTIONS.filter((flag) => value.includes(flag.emoji)).map((flag) => flag.emoji))
          setQuery('')
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground size-6 hover:border-blue-400 hover:bg-blue-500/15! active:translate-y-0"
            aria-label="Добавить флаги"
          >
            <IconFlag className="size-4" />
          </Button>
        }
      />
      <PopoverContent align="end" sideOffset={6} className="w-64">
        <InputGroup className="h-8">
          <InputGroupAddon align="inline-start">
            <IconSearch />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск: Россия / Russia"
            className="text-xs"
          />
        </InputGroup>
        <div className="grid max-h-52 grid-cols-6 gap-1 overflow-y-auto pr-1">
          {visibleFlags.map(({ emoji, label, en }) => (
            <button
              key={emoji}
              type="button"
              title={`${label} / ${en}`}
              aria-label={label}
              aria-pressed={selected.includes(emoji)}
              onClick={() => toggleFlag(emoji)}
              className={cn(
                'flex size-8 items-center justify-center rounded-md border border-transparent text-base transition-colors active:translate-y-0',
                selected.includes(emoji) ? 'border-blue-400 bg-blue-500/25' : 'hover:border-blue-400 hover:bg-blue-500/15'
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
        {visibleFlags.length === 0 && <p className="text-muted-foreground text-xs">Ничего не найдено</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">{selected.length} выбрано</span>
          <Button size="sm" disabled={!selected.length} onClick={confirm}>
            Добавить
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
