export function SettingsAppearancePage() {
  return (
    <div class="space-y-4">
      <h2 class="text-base font-semibold tracking-wide text-neutral-100">Appearance</h2>
      <div class="rounded-lg border border-white/10 bg-black/20 px-3 py-3">
        <p class="text-[0.82rem] leading-relaxed text-neutral-300">
          Desktop wallpaper and background will be drawn by the compositor behind surfaces, not in the
          shell. Configuration will arrive in a later release.
        </p>
      </div>
    </div>
  )
}
