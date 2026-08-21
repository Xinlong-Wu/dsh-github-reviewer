import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'

export interface RepositoryComboboxProps {
  label: string
  value: string
  options: readonly string[]
  disabled: boolean
  invalid: boolean
  describedBy: string
  onChange(value: string): void
  onLoad(): void
}

/** Editable, searchable listbox used by repository owner and name fields. */
export function RepositoryCombobox(props: RepositoryComboboxProps) {
  const id = useId().replaceAll(':', '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const filtered = useMemo(() => {
    const query = props.value.trim().toLowerCase()
    const seen = new Set<string>()
    return props.options.filter((option) => {
      const key = option.toLowerCase()
      if (seen.has(key) || (query !== '' && !key.includes(query))) return false
      seen.add(key)
      return true
    })
  }, [props.options, props.value])
  const filteredKey = filtered.map(option => option.toLowerCase()).join('\0')
  const previousFilteredKey = useRef(filteredKey)
  const optionsUnchanged = previousFilteredKey.current === filteredKey
  const safeActive = optionsUnchanged && active >= 0 && active < filtered.length ? active : -1
  useEffect(() => {
    if (previousFilteredKey.current !== filteredKey) previousFilteredKey.current = filteredKey
    if (active !== safeActive) setActive(safeActive)
  }, [active, filteredKey, safeActive])
  useEffect(() => {
    if (open && safeActive >= 0) optionRefs.current[safeActive]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, safeActive])
  const visible = open && !props.disabled && filtered.length > 0
  const select = (value: string): void => {
    props.onChange(value)
    setOpen(false)
    setActive(-1)
  }

  return (
    <div className="ghr-combobox-field">
      <label htmlFor={`${id}-input`}>{props.label}</label>
      <span className="ghr-combobox">
        <input
          id={`${id}-input`}
          type="text"
          role="combobox"
          autoComplete="off"
          value={props.value}
          disabled={props.disabled}
          aria-invalid={props.invalid || undefined}
          aria-describedby={props.describedBy}
          aria-expanded={visible}
          aria-autocomplete="list"
          aria-controls={`${id}-listbox`}
          aria-activedescendant={visible && safeActive >= 0 ? `${id}-option-${safeActive}` : undefined}
          onFocus={() => {
            props.onLoad()
            setOpen(true)
            setActive(-1)
          }}
          onBlur={() => { setOpen(false) }}
          onChange={(event) => {
            props.onChange(event.target.value)
            props.onLoad()
            setOpen(true)
            setActive(-1)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false)
              setActive(-1)
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              props.onLoad()
              const wasOpen = open
              setOpen(true)
              const direction = event.key === 'ArrowDown' ? 1 : -1
              setActive((current) => {
                if (filtered.length === 0) return -1
                if (!wasOpen || current < 0) return direction > 0 ? 0 : filtered.length - 1
                return (current + direction + filtered.length) % filtered.length
              })
              return
            }
            if (event.key === 'Enter' && visible && safeActive >= 0) {
              event.preventDefault()
              const option = filtered[safeActive]
              if (option !== undefined) select(option)
            }
          }}
        />
        <span className="ghr-combobox-chevron" aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
        <span id={`${id}-listbox`} className="ghr-combobox-list" role="listbox" hidden={!visible}>
          {filtered.map((option, index) => (
            <button
              id={`${id}-option-${index}`}
              ref={(element) => { optionRefs.current[index] = element }}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === safeActive}
              className={index === safeActive ? 'ghr-combobox-option ghr-combobox-option-active' : 'ghr-combobox-option'}
              key={option.toLowerCase()}
              onMouseDown={(event) => { event.preventDefault() }}
              onMouseEnter={() => { setActive(index) }}
              onClick={() => { select(option) }}
            >
              {option}
            </button>
          ))}
        </span>
      </span>
    </div>
  )
}
