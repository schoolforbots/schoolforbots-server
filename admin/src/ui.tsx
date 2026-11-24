import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEventHandler,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'

// The controls and the building blocks of the pages, written with the Tailwind classes of HyperUI's application
// components and its analytics dashboard template (https://hyperui.dev/): plain HTML elements, so the keyboard, screen
// readers and the tests see buttons, fields, radios and dialogs as they are.

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

type ButtonType = 'primary' | 'default' | 'danger' | 'link' | 'text'

const BUTTON_LOOK: Record<ButtonType, string> = {
  primary: 'border border-gray-900 bg-gray-900 text-white hover:bg-gray-800 active:bg-gray-700',
  default: 'border border-gray-300 bg-white text-gray-900 shadow-xs hover:bg-gray-50 active:bg-gray-100',
  danger: 'border border-red-200 bg-white text-red-700 shadow-xs hover:bg-red-50 active:bg-red-100',
  link: 'font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700',
  text: 'text-gray-700 hover:bg-gray-100 active:bg-gray-200',
}

export function Button({
  type = 'default',
  size = 'middle',
  htmlType = 'button',
  block = false,
  className,
  children,
  ref,
  ...rest
}: {
  type?: ButtonType
  size?: 'small' | 'middle'
  htmlType?: 'button' | 'submit'
  block?: boolean
  className?: string
  children?: ReactNode
  ref?: Ref<HTMLButtonElement>
  onClick?: MouseEventHandler<HTMLButtonElement>
  disabled?: boolean
  'aria-describedby'?: string
  'aria-pressed'?: boolean
  'aria-expanded'?: boolean
  'aria-controls'?: string
  'aria-label'?: string
  'aria-current'?: boolean | 'true' | 'false'
  tabIndex?: number
}) {
  const padded = type !== 'link'
  return (
    <button
      ref={ref}
      type={htmlType}
      className={cx(
        'ui-button inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors',
        'disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-disabled disabled:shadow-none',
        padded && (size === 'small' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'),
        !padded && 'text-sm disabled:bg-transparent',
        BUTTON_LOOK[type],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

const FIELD =
  'ui-field rounded-md border border-edge bg-white px-3 text-sm text-gray-900 shadow-xs placeholder:text-placeholder focus:border-gray-900 focus:outline-2 focus:outline-offset-0 focus:outline-gray-900 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-disabled'

/** How many characters of `max` are used, under a field that shows its count. */
function Count({ value, max }: { value: string; max?: number }) {
  return (
    <span className="ui-count mt-1 block text-right text-xs text-gray-600" aria-hidden="true">
      {max === undefined ? [...value].length : `${[...value].length} / ${max}`}
    </span>
  )
}

export function Input({
  className,
  showCount = false,
  ref,
  value,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & {
  value?: string
  showCount?: boolean
  ref?: Ref<HTMLInputElement>
}) {
  // As wide as its box; a page's own class (date-input, lookup-field) sets another width over this one.
  const field = <input ref={ref} value={value} className={cx(FIELD, 'py-2 w-full', className)} {...rest} />
  if (!showCount) return field
  return (
    <div>
      {field}
      <Count value={value ?? ''} max={rest.maxLength} />
    </div>
  )
}

/** A text box that grows with what is written in it, between `autoSize`'s rows. */
export function TextArea({
  className,
  autoSize,
  showCount = false,
  ref,
  value,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & {
  value?: string
  autoSize?: { minRows: number; maxRows: number }
  showCount?: boolean
  ref?: Ref<HTMLTextAreaElement>
}) {
  const own = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const box = own.current
    if (box === null || autoSize === undefined) return
    const style = getComputedStyle(box)
    const line = parseFloat(style.lineHeight) || 22
    const frame =
      parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) * 2 || 0
    box.style.height = 'auto'
    const wanted = Math.min(Math.max(box.scrollHeight, autoSize.minRows * line + frame), autoSize.maxRows * line + frame)
    box.style.height = `${wanted}px`
    box.style.overflowY = box.scrollHeight > wanted ? 'auto' : 'hidden'
  }, [value, autoSize?.minRows, autoSize?.maxRows])

  const field = (
    <textarea
      ref={(node) => {
        own.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      value={value}
      rows={autoSize?.minRows ?? 4}
      className={cx(FIELD, 'block w-full resize-y py-2 leading-relaxed', className)}
      {...rest}
    />
  )
  if (!showCount) return field
  return (
    <div>
      {field}
      <Count value={value ?? ''} max={rest.maxLength} />
    </div>
  )
}

/** A whole number between `min` and `max`; empty is `null`. */
export function InputNumber({
  value,
  onChange,
  onPressEnter,
  min,
  max,
  className,
  ref,
  ...rest
}: {
  value: number | null
  onChange: (value: number | null) => void
  onPressEnter?: (event: KeyboardEvent<HTMLInputElement>) => void
  min?: number
  max?: number
  precision?: number
  id?: string
  className?: string
  ref?: Ref<HTMLInputElement>
  'aria-describedby'?: string
}) {
  const { precision: _precision, ...attributes } = rest
  return (
    <input
      ref={ref}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={value ?? ''}
      className={cx(FIELD, 'py-2 w-24 tabular-nums', className)}
      onChange={(event) => {
        const text = event.target.value.trim()
        if (text === '') return onChange(null)
        const n = Math.round(Number(text))
        onChange(Number.isFinite(n) ? n : null)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onPressEnter?.(event)
      }}
      {...attributes}
    />
  )
}

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  children: ReactNode
}) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-gray-900">
      <input type="checkbox" className="ui-check size-4 rounded-sm border-edge accent-gray-900" checked={checked} onChange={onChange} />
      {children}
    </label>
  )
}

/** One choice of a few, each a radio button drawn as a bordered pill. */
export function RadioGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (event: { target: { value: T } }) => void
  options: { value: T; label: string }[]
}) {
  const name = useId()
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <label
          key={option.value}
          className="ui-choice inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-xs hover:bg-gray-50 has-checked:border-gray-900 has-checked:text-gray-900 has-checked:ring-1 has-checked:ring-gray-900"
        >
          <input
            type="radio"
            name={name}
            className="size-4 accent-gray-900"
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange({ target: { value: option.value } })}
          />
          {option.label}
        </label>
      ))}
    </div>
  )
}

/** A row of joined buttons, one of them chosen (HyperUI's button group): radio buttons underneath. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  'aria-label': label,
}: {
  options: { label: string; value: T }[]
  value: T
  onChange: (value: T) => void
  'aria-label': string
  tabIndex?: number
}) {
  const name = useId()
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-gray-200 bg-white p-0.5 text-xs font-medium">
      {options.map((option) => (
        <label
          key={String(option.value)}
          className="ui-segment relative cursor-pointer rounded-sm px-2.5 py-1 text-gray-600 hover:text-gray-900 has-checked:bg-gray-100 has-checked:text-gray-900 has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-gray-900"
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  )
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * A dialog over the page. Tab stays inside it, Esc calls `onCancel`, and when it closes the focus goes back to what
 * had it before, unless the page has already put it somewhere.
 */
export function Modal({
  open,
  title,
  footer,
  onCancel,
  afterOpenChange,
  children,
  width = 'max-w-lg',
}: {
  open: boolean
  title: ReactNode
  footer?: ReactNode
  onCancel: () => void
  afterOpenChange?: (opened: boolean) => void
  children?: ReactNode
  /** A Tailwind max-width class. */
  width?: string
  closable?: boolean
  maskClosable?: boolean
  destroyOnHidden?: boolean
}) {
  if (!open) return null
  return (
    <ModalOpen title={title} footer={footer} onCancel={onCancel} afterOpenChange={afterOpenChange} width={width}>
      {children}
    </ModalOpen>
  )
}

function ModalOpen({
  title,
  footer,
  onCancel,
  afterOpenChange,
  children,
  width,
}: {
  title: ReactNode
  footer?: ReactNode
  onCancel: () => void
  afterOpenChange?: (opened: boolean) => void
  children?: ReactNode
  width: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // Before the dialog's own content moves the focus in (its effects run after this), note where it was.
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null
    return () => {
      const now = document.activeElement
      const lost = now === null || now === document.body || (panel.current?.contains(now) ?? false)
      if (lost && before?.isConnected) before.focus()
    }
  }, [])

  useEffect(() => {
    const box = panel.current
    if (box !== null && !box.contains(document.activeElement)) box.focus()
    afterOpenChange?.(true)
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation()
      onCancel()
      return
    }
    if (event.key !== 'Tab' || panel.current === null) return
    const stops = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (stops.length === 0) {
      event.preventDefault()
      return
    }
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-gray-900/50 p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cx('ui-dialog w-full rounded-lg bg-white shadow-lg outline-none', width)}
      >
        <div className="p-6">
          <h2 id={titleId} className="text-lg font-bold text-gray-900">
            {title}
          </h2>
          <div className="mt-3 text-sm text-gray-700">{children}</div>
        </div>
        {footer !== undefined && (
          <div className="flex flex-wrap justify-end gap-2 rounded-b-lg border-t border-gray-200 bg-gray-50 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Building blocks of the pages (HyperUI's analytics dashboard)

/** A white card, `rounded-lg border border-gray-200 bg-white p-6`, with a small title and its actions on one line. */
export function Card({
  title,
  titleId,
  description,
  actions,
  className,
  children,
  label,
}: {
  title?: ReactNode
  titleId?: string
  description?: ReactNode
  actions?: ReactNode
  className?: string
  children?: ReactNode
  /** The card's name when it has no title. */
  label?: string
}) {
  const ownId = useId()
  const headingId = titleId ?? ownId
  return (
    <section
      className={cx('rounded-lg border border-gray-200 bg-white p-6', className)}
      aria-labelledby={title === undefined ? undefined : headingId}
      aria-label={title === undefined ? label : undefined}
    >
      {(title !== undefined || actions !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {title !== undefined && (
            <h2 id={headingId} className="text-sm font-medium text-gray-900">
              {title}
            </h2>
          )}
          {actions !== undefined && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {description !== undefined && <p className="mt-1 text-sm text-gray-600">{description}</p>}
      {children}
    </section>
  )
}

export type Tone = 'gray' | 'green' | 'yellow' | 'red' | 'indigo' | 'blue'

const TONES: Record<Tone, string> = {
  gray: 'bg-gray-100 text-gray-700',
  green: 'bg-green-100 text-green-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  red: 'bg-red-100 text-red-700',
  indigo: 'bg-indigo-100 text-indigo-700',
  blue: 'bg-blue-100 text-blue-700',
}

/** A status in a small rounded label (HyperUI's badges): the words say it, the colour only helps. */
export function Badge({ tone = 'gray', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cx(
        'ui-badge inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** The classes of HyperUI's tables, for the pages' own tables. */
// The thick line under the header is drawn on the thead (styles.css): `divide-y-2` on the table would count a caption.
export const TABLE = 'ui-table min-w-full text-sm'
export const TH = 'px-3 py-2 text-left font-medium whitespace-nowrap text-gray-900'
export const TBODY = 'divide-y divide-gray-200'
export const TD = 'px-3 py-2 text-gray-700'

/** A line of label and value (HyperUI's details list), inside a `<dl className="divide-y divide-gray-200">`. */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 py-3">
      <dt className="font-medium text-gray-900">{label}</dt>
      <dd className="col-span-2 text-gray-700">{children}</dd>
    </div>
  )
}

const SPARK = { indigo: '#4f46e5', green: '#059669', red: '#e11d48', gray: '#6b7280' }

/** A small line of a series under a number (the template's sparkline). It only repeats the numbers: hidden. */
export function Sparkline({ values, tone = 'indigo' }: { values: number[]; tone?: keyof typeof SPARK }) {
  if (values.length < 2) return <div className="h-10" aria-hidden="true" />
  const width = 120
  const height = 40
  const high = Math.max(...values)
  const low = Math.min(...values)
  const span = high - low || 1
  const line = values
    .map((value, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 3 - ((value - low) / span) * (height - 6)).toFixed(1)}`)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block h-10 w-full" aria-hidden="true">
      <polyline
        points={line}
        fill="none"
        stroke={SPARK[tone]}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export const PAGE_ACTIONS_ID = 'page-actions'

/**
 * Puts a page's main actions in the header, right of its title (the template's "New report"). A page shown without
 * the frame (on its own, as in the tests) keeps them where it put them.
 */
export function PageActions({ children }: { children: ReactNode }) {
  // undefined until the header is looked for, before the first paint.
  const [slot, setSlot] = useState<HTMLElement | null>()
  useLayoutEffect(() => setSlot(document.getElementById(PAGE_ACTIONS_ID)), [])
  if (slot === undefined) return null
  return slot === null ? <div className="mb-4 flex flex-wrap justify-end gap-2">{children}</div> : createPortal(children, slot)
}
