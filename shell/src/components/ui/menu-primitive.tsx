import {
  Show,
  createContext,
  createSignal,
  mergeProps,
  splitProps,
  useContext,
  type Accessor,
  type Component,
  type JSX,
  type ParentComponent,
  type ValidComponent,
} from 'solid-js'
import { Dynamic, Portal } from 'solid-js/web'

export type MenuRootProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children: JSX.Element
}

type MenuRootCtx = {
  open: Accessor<boolean>
  setOpen: (next: boolean) => void
}

function createMenuNamespace() {
  const MenuCtx = createContext<MenuRootCtx>()

  const Root: ParentComponent<MenuRootProps> = (props) => {
    const [uncontrolledOpen, setUncontrolledOpen] = createSignal(props.defaultOpen ?? false)
    const open = () => (props.open !== undefined ? props.open : uncontrolledOpen())
    const setOpen = (next: boolean) => {
      if (props.open === undefined) setUncontrolledOpen(next)
      props.onOpenChange?.(next)
    }
    const value: MenuRootCtx = { open: () => open(), setOpen }
    return <MenuCtx.Provider value={value}>{props.children}</MenuCtx.Provider>
  }

  function useMenuRoot(label: string): MenuRootCtx {
    const v = useContext(MenuCtx)
    if (!v) throw new Error(`${label} must be used within Root`)
    return v
  }

  type PortalProps = {
    mount?: Node
    children: JSX.Element
  }

  const MenuPortal: ParentComponent<PortalProps> = (props) => {
    const mount = () => props.mount ?? document.body
    return <Portal mount={mount()}>{props.children}</Portal>
  }

  type ContentProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, 'children'> & {
    children?: JSX.Element
    when?: Accessor<boolean>
  }

  const MenuContent: Component<ContentProps> = (raw) => {
    const menu = useMenuRoot('MenuContent')
    const [local, rest] = splitProps(raw, ['children', 'class', 'classList', 'when', 'role'])
    const visible = () => (local.when ? local.when() : menu.open())
    return (
      <Show when={visible()}>
        <div
          role={(local.role ?? 'menu') as JSX.HTMLAttributes<HTMLDivElement>['role']}
          class={local.class}
          classList={local.classList}
          {...rest}
        >
          {local.children}
        </div>
      </Show>
    )
  }

  type TriggerProps = JSX.ButtonHTMLAttributes<HTMLButtonElement>

  const MenuTrigger: Component<TriggerProps> = (raw) => {
    const menu = useMenuRoot('MenuTrigger')
    const [local, rest] = splitProps(raw, ['onClick', 'type'])
    return (
      <button
        type={local.type ?? 'button'}
        aria-expanded={menu.open()}
        aria-haspopup="menu"
        {...rest}
        onClick={(e) => {
          typeof local.onClick === 'function' && local.onClick.call(e.currentTarget, e)
          if (!e.defaultPrevented) menu.setOpen(!menu.open())
        }}
      />
    )
  }

  type ItemProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    inset?: boolean
  }

  const MenuItem: Component<ItemProps> = (raw) => {
    const [local, rest] = splitProps(raw, ['class', 'classList', 'inset', 'type', 'children'])
    return (
      <button
        type={local.type ?? 'button'}
        role="menuitem"
        tabIndex={-1}
        class={`bg-transparent hover:bg-(--shell-overlay-hover) flex w-full cursor-pointer items-center justify-between gap-2 border-0 px-3 py-[0.45rem] text-left font-inherit text-inherit${local.inset ? ' pl-8' : ''}${local.class ? ` ${local.class}` : ''}`}
        classList={local.classList}
        {...rest}
      >
        {local.children}
      </button>
    )
  }

  const MenuSeparator: Component<JSX.HTMLAttributes<HTMLDivElement>> = (raw) => {
    const [local, rest] = splitProps(raw, ['class', 'classList'])
    return (
      <div
        role="separator"
        aria-orientation="horizontal"
        class={`my-1 h-px bg-(--shell-border) mx-2${local.class ? ` ${local.class}` : ''}`}
        classList={local.classList}
        {...rest}
      />
    )
  }

  const MenuLabel: Component<JSX.HTMLAttributes<HTMLDivElement>> = (raw) => {
    const [local, rest] = splitProps(raw, ['class', 'classList'])
    return (
      <div
        class={`text-(--shell-text-dim) px-2 py-1.5 text-[0.7rem] font-semibold uppercase tracking-wide${local.class ? ` ${local.class}` : ''}`}
        classList={local.classList}
        {...rest}
      />
    )
  }

  const MenuGroup: ParentComponent<JSX.HTMLAttributes<HTMLDivElement>> = (raw) => {
    const [local, rest] = splitProps(raw, ['children', 'class', 'classList'])
    return (
      <div role="group" class={local.class} classList={local.classList} {...rest}>
        {local.children}
      </div>
    )
  }

  const MenuShortcut: Component<JSX.HTMLAttributes<HTMLSpanElement>> = (raw) => {
    const [local, rest] = splitProps(raw, ['class', 'classList', 'children'])
    return (
      <span
        class={`text-(--shell-text-dim) ml-auto text-[0.65rem] tracking-wide${local.class ? ` ${local.class}` : ''}`}
        classList={local.classList}
        {...rest}
      >
        {local.children}
      </span>
    )
  }

  type CheckboxProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
    checked?: boolean
    children?: JSX.Element
    onCheckedChange?: (checked: boolean) => void
  }

  const MenuCheckboxItem: Component<CheckboxProps> = (raw) => {
    const merged = mergeProps({ checked: false }, raw)
    const [local, rest] = splitProps(merged, [
      'checked',
      'onCheckedChange',
      'class',
      'classList',
      'type',
      'children',
      'onClick',
    ])
    return (
      <button
        type={local.type ?? 'button'}
        role="menuitemcheckbox"
        aria-checked={local.checked === true}
        tabIndex={-1}
        class={`bg-transparent hover:bg-(--shell-overlay-hover) flex w-full cursor-pointer items-center gap-2 border-0 px-3 py-[0.45rem] text-left font-inherit text-inherit${local.class ? ` ${local.class}` : ''}`}
        classList={local.classList}
        {...rest}
        onClick={(e) => {
          typeof local.onClick === 'function' && local.onClick.call(e.currentTarget, e)
          if (!e.defaultPrevented) local.onCheckedChange?.(!local.checked)
        }}
      >
        <span class="w-4 shrink-0 text-center text-[0.7rem]">{local.checked ? '✓' : ''}</span>
        <span class="min-w-0 flex-1">{local.children}</span>
      </button>
    )
  }

  type RadioGroupProps = {
    value?: string
    onValueChange?: (value: string) => void
    children: JSX.Element
  }

  const RadioCtx = createContext<{
    value: () => string | undefined
    setValue: (v: string) => void
  }>()

  const MenuRadioGroup: ParentComponent<RadioGroupProps> = (props) => {
    const [value, setValue] = createSignal(props.value ?? '')
    const current = () => (props.value !== undefined ? props.value : value())
    const set = (v: string) => {
      if (props.value === undefined) setValue(v)
      props.onValueChange?.(v)
    }
    return <RadioCtx.Provider value={{ value: current, setValue: set }}>{props.children}</RadioCtx.Provider>
  }

  type RadioItemProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    value: string
    children?: JSX.Element
  }

  const MenuRadioItem: Component<RadioItemProps> = (raw) => {
    const radio = useContext(RadioCtx)
    if (!radio) throw new Error('MenuRadioItem must be used within MenuRadioGroup')
    const [local, rest] = splitProps(raw, ['value', 'class', 'classList', 'type', 'children', 'onClick'])
    const checked = () => radio.value() === local.value
    return (
      <button
        type={local.type ?? 'button'}
        role="menuitemradio"
        aria-checked={checked()}
        tabIndex={-1}
        class={`bg-transparent hover:bg-(--shell-overlay-hover) flex w-full cursor-pointer items-center gap-2 border-0 px-3 py-[0.45rem] text-left font-inherit text-inherit${local.class ? ` ${local.class}` : ''}`}
        classList={local.classList}
        {...rest}
        onClick={(e) => {
          typeof local.onClick === 'function' && local.onClick.call(e.currentTarget, e)
          if (!e.defaultPrevented) radio.setValue(local.value)
        }}
      >
        <span class="w-4 shrink-0 text-center text-[0.7rem]">{checked() ? '●' : ''}</span>
        <span class="min-w-0 flex-1">{local.children}</span>
      </button>
    )
  }

  const SubCtx = createContext<{
    open: Accessor<boolean>
    setOpen: (v: boolean) => void
  }>()

  const MenuSub: ParentComponent = (props) => {
    const [open, setOpen] = createSignal(false)
    return <SubCtx.Provider value={{ open, setOpen }}>{props.children}</SubCtx.Provider>
  }

  const MenuSubTrigger: Component<JSX.ButtonHTMLAttributes<HTMLButtonElement>> = (raw) => {
    const sub = useContext(SubCtx)
    if (!sub) throw new Error('MenuSubTrigger must be used within MenuSub')
    useMenuRoot('MenuSubTrigger')
    const [local, rest] = splitProps(raw, ['onClick', 'type', 'children'])
    return (
      <button
        type={local.type ?? 'button'}
        role="menuitem"
        aria-expanded={sub.open()}
        aria-haspopup="menu"
        tabIndex={-1}
        class="bg-transparent hover:bg-(--shell-overlay-hover) flex w-full cursor-pointer items-center justify-between gap-2 border-0 px-3 py-[0.45rem] text-left font-inherit text-inherit"
        {...rest}
        onClick={(e) => {
          typeof local.onClick === 'function' && local.onClick.call(e.currentTarget, e)
          if (!e.defaultPrevented) sub.setOpen(!sub.open())
        }}
      >
        <span class="min-w-0 flex-1">{local.children}</span>
        <span class="text-(--shell-text-dim) shrink-0 text-[0.65rem]">›</span>
      </button>
    )
  }

  const MenuSubContent: ParentComponent<JSX.HTMLAttributes<HTMLDivElement>> = (raw) => {
    const sub = useContext(SubCtx)
    if (!sub) throw new Error('MenuSubContent must be used within MenuSub')
    useMenuRoot('MenuSubContent')
    const [local, rest] = splitProps(raw, ['children', 'class', 'classList'])
    return (
      <Show when={sub.open()}>
        <div
          role="menu"
          class={`border border-(--shell-overlay-border) bg-(--shell-overlay) mt-1 flex min-w-40 flex-col overflow-hidden rounded-[0.35rem] py-1 shadow-lg${local.class ? ` ${local.class}` : ''}`}
          classList={local.classList}
          {...rest}
        >
          {local.children}
        </div>
      </Show>
    )
  }

  type ContextTriggerProps = JSX.HTMLAttributes<HTMLElement> & {
    as?: ValidComponent
  }

  const ContextMenuTrigger: Component<ContextTriggerProps> = (raw) => {
    const menu = useMenuRoot('ContextMenuTrigger')
    const merged = mergeProps({ as: 'div' as const }, raw)
    const [local, rest] = splitProps(merged, ['as', 'children', 'onContextMenu'])
    return (
      <Dynamic
        component={local.as}
        {...rest}
        onContextMenu={(e: MouseEvent & { currentTarget: HTMLElement; target: Element }) => {
          const h = local.onContextMenu
          if (typeof h === 'function') (h as (ev: typeof e) => void)(e)
          if (!e.defaultPrevented) {
            e.preventDefault()
            menu.setOpen(true)
          }
        }}
      >
        {local.children}
      </Dynamic>
    )
  }

  return {
    Root,
    Portal: MenuPortal,
    Content: MenuContent,
    Trigger: MenuTrigger,
    Item: MenuItem,
    Separator: MenuSeparator,
    Label: MenuLabel,
    Group: MenuGroup,
    Shortcut: MenuShortcut,
    CheckboxItem: MenuCheckboxItem,
    RadioGroup: MenuRadioGroup,
    RadioItem: MenuRadioItem,
    Sub: MenuSub,
    SubTrigger: MenuSubTrigger,
    SubContent: MenuSubContent,
    ContextTrigger: ContextMenuTrigger,
  }
}

const dropdownNs = createMenuNamespace()
const contextNs = createMenuNamespace()

export const dropdownMenuPrimitive = {
  Root: dropdownNs.Root,
  Portal: dropdownNs.Portal,
  Content: dropdownNs.Content,
  Trigger: dropdownNs.Trigger,
  Item: dropdownNs.Item,
  Separator: dropdownNs.Separator,
  Label: dropdownNs.Label,
  Group: dropdownNs.Group,
  Shortcut: dropdownNs.Shortcut,
  CheckboxItem: dropdownNs.CheckboxItem,
  RadioGroup: dropdownNs.RadioGroup,
  RadioItem: dropdownNs.RadioItem,
  Sub: dropdownNs.Sub,
  SubTrigger: dropdownNs.SubTrigger,
  SubContent: dropdownNs.SubContent,
}

export const contextMenuPrimitive = {
  Root: contextNs.Root,
  Portal: contextNs.Portal,
  Content: contextNs.Content,
  Trigger: contextNs.Trigger,
  Item: contextNs.Item,
  Separator: contextNs.Separator,
  Label: contextNs.Label,
  Group: contextNs.Group,
  Shortcut: contextNs.Shortcut,
  CheckboxItem: contextNs.CheckboxItem,
  RadioGroup: contextNs.RadioGroup,
  RadioItem: contextNs.RadioItem,
  Sub: contextNs.Sub,
  SubTrigger: contextNs.SubTrigger,
  SubContent: contextNs.SubContent,
  ContextTrigger: contextNs.ContextTrigger,
}

