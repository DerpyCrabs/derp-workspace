type ShellTestWindowContentProps = {
  windowId: number
  title: string
}

export function ShellTestWindowContent(props: ShellTestWindowContentProps) {
  return (
    <div
      class="flex h-full min-h-0 flex-col gap-3 overflow-auto"
      data-shell-test-window={props.windowId}
      data-shell-test-window-title={props.title}
    >
      <div class="grid gap-2" data-shell-test-window-marker>
        <div class="flex h-12 items-stretch gap-2">
          <div class="w-12 rounded-md bg-[#64dfdf]" />
          <div class="flex-1 rounded-md bg-[#ffd166]" />
        </div>
        <div class="grid grid-cols-3 gap-2">
          <div class="h-6 rounded-md bg-[#ef476f]" />
          <div class="h-6 rounded-md bg-[#118ab2]" />
          <div class="h-6 rounded-md bg-[#06d6a0]" />
        </div>
      </div>
      <div class="flex items-center justify-between gap-3">
        <h2 class="m-0 text-base font-semibold text-(--shell-text)">{props.title}</h2>
        <span class="rounded border border-(--shell-border) px-2 py-1 text-[11px] text-(--shell-text-muted)">
          js-{props.windowId}
        </span>
      </div>
      <div class="grid gap-2 sm:grid-cols-2">
        <div class="rounded border border-(--shell-border) bg-(--shell-surface-panel) px-3 py-2">
          <p class="m-0 text-[11px] uppercase tracking-[0.08em] text-(--shell-text-dim)">Window Id</p>
          <p class="m-0 mt-1 text-sm font-medium text-(--shell-text)">{props.windowId}</p>
        </div>
        <div class="rounded border border-(--shell-border) bg-(--shell-surface-panel) px-3 py-2">
          <p class="m-0 text-[11px] uppercase tracking-[0.08em] text-(--shell-text-dim)">Fixture</p>
          <p class="m-0 mt-1 text-sm font-medium text-(--shell-text)">Reusable js test window</p>
        </div>
      </div>
    </div>
  )
}
