import {
  getThemeSettings,
  prefersDarkTheme,
  resolveThemeMode,
  subscribeThemeStore,
  type ThemePalette,
  type ThemeSettings,
} from './themeStore'

type ThemeTokenMap = Record<string, string>

export type ResolvedTheme = {
  palette: ThemePalette
  mode: 'light' | 'dark'
  tokens: ThemeTokenMap
}

const THEMES: Record<ThemePalette, Record<'light' | 'dark', ThemeTokenMap>> = {
  default: {
    dark: {
      'shell-text': 'hsl(215 20% 92%)',
      'shell-text-muted': 'hsl(216 12% 74%)',
      'shell-text-dim': 'hsl(216 10% 56%)',
      'shell-text-strong': 'hsl(211 42% 74%)',
      'shell-text-mono': 'hsl(211 34% 72%)',
      'shell-border': 'hsl(219 16% 24% / 0.78)',
      'shell-border-strong': 'hsl(218 16% 34% / 0.9)',
      'shell-surface': 'hsl(220 18% 14% / 0.9)',
      'shell-surface-panel': 'hsl(220 19% 12% / 0.95)',
      'shell-surface-elevated': 'hsl(220 18% 17% / 0.97)',
      'shell-surface-inset': 'hsl(220 18% 10% / 0.92)',
      'shell-surface-hover': 'hsl(219 15% 21% / 0.96)',
      'shell-taskbar-bg': 'hsl(220 20% 11% / 0.97)',
      'shell-accent': 'hsl(211 34% 64%)',
      'shell-accent-hover': 'hsl(211 36% 58%)',
      'shell-accent-foreground': 'hsl(220 28% 12%)',
      'shell-accent-border': 'hsl(211 28% 46% / 0.78)',
      'shell-accent-soft': 'hsl(213 28% 26% / 0.38)',
      'shell-accent-soft-border': 'hsl(211 26% 42% / 0.54)',
      'shell-accent-soft-text': 'hsl(211 30% 80%)',
      'shell-control-muted-bg': 'hsl(220 16% 19% / 0.95)',
      'shell-control-muted-hover': 'hsl(219 15% 23% / 0.95)',
      'shell-control-muted-text': 'hsl(215 14% 85%)',
      'shell-input-bg': 'hsl(220 18% 11% / 0.96)',
      'shell-input-border': 'hsl(218 14% 29% / 0.9)',
      'shell-input-focus': 'hsl(211 30% 48%)',
      'shell-overlay': 'hsl(220 18% 13% / 0.98)',
      'shell-overlay-border': 'hsl(220 16% 10% / 0.78)',
      'shell-overlay-hover': 'hsl(219 14% 20% / 0.94)',
      'shell-overlay-active': 'hsl(214 22% 24% / 0.94)',
      'shell-overlay-muted': 'hsl(216 24% 15% / 0.24)',
      'shell-warning-bg': 'hsl(33 70% 18% / 0.94)',
      'shell-warning-border': 'hsl(38 80% 40% / 0.35)',
      'shell-warning-text': 'hsl(45 90% 84%)',
      'shell-preview-outline': 'hsl(203 44% 54% / 0.68)',
      'shell-preview-shadow': 'rgba(104, 141, 186, 0.14)',
      'shell-display-preview-bg': 'hsl(220 20% 11% / 0.97)',
      'shell-display-preview-glow':
        'radial-gradient(circle at top, rgba(86, 107, 141, 0.16), transparent 58%)',
      'shell-display-card-bg': 'linear-gradient(180deg, rgba(67, 76, 96, 0.94), rgba(36, 41, 56, 0.98))',
      'shell-display-card-border': 'hsl(216 14% 34% / 0.72)',
      'shell-display-card-primary-bg':
        'linear-gradient(180deg, rgba(82, 107, 146, 0.95), rgba(47, 64, 92, 0.98))',
      'shell-display-card-primary-border': 'hsl(211 26% 54% / 0.7)',
      'shell-window-chrome-focused': 'hsl(218 16% 22%)',
      'shell-window-chrome-unfocused': 'hsl(219 15% 14%)',
      'shell-cursor-readout': 'hsl(211 34% 64%)',
      'shell-crosshair': 'hsl(211 44% 56% / 0.74)',
      'shell-scrollbar-track': 'hsl(220 18% 11% / 0.96)',
      'shell-scrollbar-thumb': 'hsl(216 12% 30% / 0.95)',
      'shell-scrollbar-thumb-hover': 'hsl(214 16% 40% / 0.98)',
    },
    light: {
      'shell-text': 'hsl(221 38% 14%)',
      'shell-text-muted': 'hsl(220 18% 30%)',
      'shell-text-dim': 'hsl(220 10% 45%)',
      'shell-text-strong': 'hsl(214 72% 36%)',
      'shell-text-mono': 'hsl(214 62% 38%)',
      'shell-border': 'hsl(220 24% 78% / 0.9)',
      'shell-border-strong': 'hsl(216 28% 68% / 0.95)',
      'shell-surface': 'hsl(0 0% 100% / 0.9)',
      'shell-surface-panel': 'hsl(210 32% 97% / 0.96)',
      'shell-surface-elevated': 'hsl(210 28% 99% / 0.98)',
      'shell-surface-inset': 'hsl(214 32% 93% / 0.92)',
      'shell-surface-hover': 'hsl(214 34% 94% / 0.98)',
      'shell-taskbar-bg': 'hsl(210 36% 95% / 0.96)',
      'shell-accent': 'hsl(212 78% 58%)',
      'shell-accent-hover': 'hsl(212 82% 52%)',
      'shell-accent-foreground': 'hsl(0 0% 100%)',
      'shell-accent-border': 'hsl(212 72% 48% / 0.68)',
      'shell-accent-soft': 'hsl(212 84% 92%)',
      'shell-accent-soft-border': 'hsl(212 66% 74% / 0.8)',
      'shell-accent-soft-text': 'hsl(214 78% 32%)',
      'shell-control-muted-bg': 'hsl(0 0% 100% / 0.92)',
      'shell-control-muted-hover': 'hsl(210 36% 94% / 0.98)',
      'shell-control-muted-text': 'hsl(221 32% 18%)',
      'shell-input-bg': 'hsl(0 0% 100% / 0.96)',
      'shell-input-border': 'hsl(219 22% 76% / 0.92)',
      'shell-input-focus': 'hsl(212 78% 55%)',
      'shell-overlay': 'hsl(210 36% 98% / 0.98)',
      'shell-overlay-border': 'hsl(218 22% 78% / 0.9)',
      'shell-overlay-hover': 'hsl(212 44% 94% / 0.96)',
      'shell-overlay-active': 'hsl(212 66% 89% / 0.98)',
      'shell-overlay-muted': 'hsl(212 54% 76% / 0.18)',
      'shell-warning-bg': 'hsl(42 100% 95%)',
      'shell-warning-border': 'hsl(38 88% 66% / 0.7)',
      'shell-warning-text': 'hsl(27 68% 28%)',
      'shell-preview-outline': 'hsl(201 92% 46% / 0.7)',
      'shell-preview-shadow': 'rgba(0, 153, 255, 0.14)',
      'shell-display-preview-bg': 'hsl(210 38% 96% / 0.98)',
      'shell-display-preview-glow':
        'radial-gradient(circle at top, rgba(83, 140, 232, 0.16), transparent 58%)',
      'shell-display-card-bg':
        'linear-gradient(180deg, rgba(238, 244, 255, 0.98), rgba(217, 227, 245, 0.99))',
      'shell-display-card-border': 'hsl(216 34% 74% / 0.88)',
      'shell-display-card-primary-bg':
        'linear-gradient(180deg, rgba(108, 157, 241, 0.94), rgba(71, 110, 206, 0.96))',
      'shell-display-card-primary-border': 'hsl(214 82% 60% / 0.72)',
      'shell-window-chrome-focused': 'hsl(214 36% 88%)',
      'shell-window-chrome-unfocused': 'hsl(215 26% 83%)',
      'shell-cursor-readout': 'hsl(213 82% 58%)',
      'shell-crosshair': 'hsl(210 78% 52% / 0.78)',
      'shell-scrollbar-track': 'hsl(214 32% 92% / 0.96)',
      'shell-scrollbar-thumb': 'hsl(214 22% 72% / 0.95)',
      'shell-scrollbar-thumb-hover': 'hsl(213 34% 62% / 0.98)',
    },
  },
  caffeine: {
    dark: {
      'shell-text': 'hsl(32 24% 93%)',
      'shell-text-muted': 'hsl(31 16% 76%)',
      'shell-text-dim': 'hsl(29 10% 57%)',
      'shell-text-strong': 'hsl(31 34% 74%)',
      'shell-text-mono': 'hsl(31 26% 70%)',
      'shell-border': 'hsl(25 14% 24% / 0.76)',
      'shell-border-strong': 'hsl(27 18% 32% / 0.88)',
      'shell-surface': 'hsl(24 16% 14% / 0.9)',
      'shell-surface-panel': 'hsl(23 18% 12% / 0.95)',
      'shell-surface-elevated': 'hsl(24 18% 17% / 0.97)',
      'shell-surface-inset': 'hsl(22 20% 10% / 0.92)',
      'shell-surface-hover': 'hsl(24 16% 21% / 0.96)',
      'shell-taskbar-bg': 'hsl(23 20% 11% / 0.97)',
      'shell-accent': 'hsl(30 38% 58%)',
      'shell-accent-hover': 'hsl(30 40% 52%)',
      'shell-accent-foreground': 'hsl(24 44% 12%)',
      'shell-accent-border': 'hsl(30 30% 42% / 0.8)',
      'shell-accent-soft': 'hsl(28 24% 24% / 0.38)',
      'shell-accent-soft-border': 'hsl(30 28% 38% / 0.54)',
      'shell-accent-soft-text': 'hsl(31 28% 78%)',
      'shell-control-muted-bg': 'hsl(23 16% 19% / 0.95)',
      'shell-control-muted-hover': 'hsl(24 16% 23% / 0.95)',
      'shell-control-muted-text': 'hsl(31 14% 84%)',
      'shell-input-bg': 'hsl(22 18% 11% / 0.96)',
      'shell-input-border': 'hsl(26 14% 28% / 0.9)',
      'shell-input-focus': 'hsl(30 28% 44%)',
      'shell-overlay': 'hsl(24 17% 13% / 0.98)',
      'shell-overlay-border': 'hsl(22 18% 10% / 0.78)',
      'shell-overlay-hover': 'hsl(24 15% 20% / 0.94)',
      'shell-overlay-active': 'hsl(28 20% 24% / 0.94)',
      'shell-overlay-muted': 'hsl(25 22% 14% / 0.28)',
      'shell-warning-bg': 'hsl(20 76% 17% / 0.94)',
      'shell-warning-border': 'hsl(27 84% 42% / 0.36)',
      'shell-warning-text': 'hsl(42 94% 84%)',
      'shell-preview-outline': 'hsl(30 42% 52% / 0.68)',
      'shell-preview-shadow': 'rgba(166, 126, 82, 0.15)',
      'shell-display-preview-bg': 'hsl(23 20% 11% / 0.97)',
      'shell-display-preview-glow':
        'radial-gradient(circle at top, rgba(149, 112, 76, 0.18), transparent 58%)',
      'shell-display-card-bg':
        'linear-gradient(180deg, rgba(92, 71, 57, 0.94), rgba(54, 39, 31, 0.98))',
      'shell-display-card-border': 'hsl(28 16% 34% / 0.72)',
      'shell-display-card-primary-bg':
        'linear-gradient(180deg, rgba(120, 92, 68, 0.95), rgba(79, 55, 38, 0.98))',
      'shell-display-card-primary-border': 'hsl(30 24% 48% / 0.7)',
      'shell-window-chrome-focused': 'hsl(24 18% 22%)',
      'shell-window-chrome-unfocused': 'hsl(21 18% 15%)',
      'shell-cursor-readout': 'hsl(30 34% 62%)',
      'shell-crosshair': 'hsl(30 44% 54% / 0.74)',
      'shell-scrollbar-track': 'hsl(23 26% 11% / 0.96)',
      'shell-scrollbar-thumb': 'hsl(27 18% 28% / 0.95)',
      'shell-scrollbar-thumb-hover': 'hsl(29 22% 38% / 0.98)',
    },
    light: {
      'shell-text': 'hsl(24 40% 16%)',
      'shell-text-muted': 'hsl(24 22% 31%)',
      'shell-text-dim': 'hsl(24 10% 46%)',
      'shell-text-strong': 'hsl(28 78% 34%)',
      'shell-text-mono': 'hsl(28 60% 38%)',
      'shell-border': 'hsl(31 30% 78% / 0.9)',
      'shell-border-strong': 'hsl(30 32% 66% / 0.94)',
      'shell-surface': 'hsl(40 38% 98% / 0.94)',
      'shell-surface-panel': 'hsl(36 42% 96% / 0.97)',
      'shell-surface-elevated': 'hsl(40 48% 99% / 0.98)',
      'shell-surface-inset': 'hsl(36 42% 92% / 0.94)',
      'shell-surface-hover': 'hsl(36 48% 93% / 0.98)',
      'shell-taskbar-bg': 'hsl(37 44% 94% / 0.97)',
      'shell-accent': 'hsl(30 52% 54%)',
      'shell-accent-hover': 'hsl(29 56% 48%)',
      'shell-accent-foreground': 'hsl(0 0% 100%)',
      'shell-accent-border': 'hsl(29 48% 46% / 0.72)',
      'shell-accent-soft': 'hsl(33 54% 88%)',
      'shell-accent-soft-border': 'hsl(30 38% 66% / 0.82)',
      'shell-accent-soft-text': 'hsl(26 46% 28%)',
      'shell-control-muted-bg': 'hsl(40 38% 100% / 0.92)',
      'shell-control-muted-hover': 'hsl(36 46% 93% / 0.98)',
      'shell-control-muted-text': 'hsl(24 34% 20%)',
      'shell-input-bg': 'hsl(40 40% 100% / 0.96)',
      'shell-input-border': 'hsl(31 24% 76% / 0.92)',
      'shell-input-focus': 'hsl(30 52% 50%)',
      'shell-overlay': 'hsl(39 44% 98% / 0.98)',
      'shell-overlay-border': 'hsl(31 28% 78% / 0.9)',
      'shell-overlay-hover': 'hsl(34 52% 93% / 0.96)',
      'shell-overlay-active': 'hsl(33 44% 84% / 0.98)',
      'shell-overlay-muted': 'hsl(31 64% 74% / 0.18)',
      'shell-warning-bg': 'hsl(42 100% 94%)',
      'shell-warning-border': 'hsl(34 86% 62% / 0.72)',
      'shell-warning-text': 'hsl(25 68% 28%)',
      'shell-preview-outline': 'hsl(30 54% 46% / 0.68)',
      'shell-preview-shadow': 'rgba(186, 130, 72, 0.14)',
      'shell-display-preview-bg': 'hsl(38 46% 95% / 0.98)',
      'shell-display-preview-glow':
        'radial-gradient(circle at top, rgba(234, 171, 95, 0.18), transparent 58%)',
      'shell-display-card-bg':
        'linear-gradient(180deg, rgba(252, 242, 226, 0.98), rgba(240, 222, 198, 0.99))',
      'shell-display-card-border': 'hsl(31 34% 72% / 0.88)',
      'shell-display-card-primary-bg':
        'linear-gradient(180deg, rgba(214, 168, 118, 0.95), rgba(186, 124, 70, 0.98))',
      'shell-display-card-primary-border': 'hsl(30 46% 56% / 0.74)',
      'shell-window-chrome-focused': 'hsl(34 34% 88%)',
      'shell-window-chrome-unfocused': 'hsl(34 30% 83%)',
      'shell-cursor-readout': 'hsl(30 52% 54%)',
      'shell-crosshair': 'hsl(30 54% 50% / 0.78)',
      'shell-scrollbar-track': 'hsl(37 40% 91% / 0.96)',
      'shell-scrollbar-thumb': 'hsl(31 28% 68% / 0.95)',
      'shell-scrollbar-thumb-hover': 'hsl(30 40% 56% / 0.98)',
    },
  },
  'cosmic-night': {
    dark: {
      'shell-text': 'hsl(252 34% 96%)',
      'shell-text-muted': 'hsl(248 22% 82%)',
      'shell-text-dim': 'hsl(248 14% 62%)',
      'shell-text-strong': 'hsl(274 90% 86%)',
      'shell-text-mono': 'hsl(262 78% 82%)',
      'shell-border': 'hsl(251 22% 28% / 0.76)',
      'shell-border-strong': 'hsl(252 28% 42% / 0.9)',
      'shell-surface': 'hsl(248 26% 15% / 0.9)',
      'shell-surface-panel': 'hsl(248 30% 12% / 0.95)',
      'shell-surface-elevated': 'hsl(250 28% 18% / 0.97)',
      'shell-surface-inset': 'hsl(247 30% 10% / 0.92)',
      'shell-surface-hover': 'hsl(249 24% 24% / 0.96)',
      'shell-taskbar-bg': 'hsl(249 30% 11% / 0.96)',
      'shell-accent': 'hsl(271 82% 74%)',
      'shell-accent-hover': 'hsl(271 88% 68%)',
      'shell-accent-foreground': 'hsl(255 44% 12%)',
      'shell-accent-border': 'hsl(270 72% 60% / 0.82)',
      'shell-accent-soft': 'hsl(268 56% 34% / 0.44)',
      'shell-accent-soft-border': 'hsl(270 74% 62% / 0.58)',
      'shell-accent-soft-text': 'hsl(278 96% 90%)',
      'shell-control-muted-bg': 'hsl(248 24% 20% / 0.95)',
      'shell-control-muted-hover': 'hsl(250 25% 27% / 0.95)',
      'shell-control-muted-text': 'hsl(250 24% 90%)',
      'shell-input-bg': 'hsl(247 26% 12% / 0.95)',
      'shell-input-border': 'hsl(250 22% 35% / 0.9)',
      'shell-input-focus': 'hsl(270 74% 62%)',
      'shell-overlay': 'hsl(248 28% 14% / 0.97)',
      'shell-overlay-border': 'hsl(247 28% 10% / 0.78)',
      'shell-overlay-hover': 'hsl(250 22% 25% / 0.94)',
      'shell-overlay-active': 'hsl(268 40% 28% / 0.94)',
      'shell-overlay-muted': 'hsl(258 48% 16% / 0.3)',
      'shell-warning-bg': 'hsl(286 42% 18% / 0.94)',
      'shell-warning-border': 'hsl(287 66% 40% / 0.36)',
      'shell-warning-text': 'hsl(293 94% 90%)',
      'shell-preview-outline': 'hsl(286 92% 72% / 0.72)',
      'shell-preview-shadow': 'rgba(185, 102, 255, 0.18)',
      'shell-display-preview-bg': 'hsl(248 30% 11% / 0.96)',
      'shell-display-preview-glow':
        'radial-gradient(circle at top, rgba(135, 108, 219, 0.24), transparent 58%)',
      'shell-display-card-bg':
        'linear-gradient(180deg, rgba(84, 76, 129, 0.95), rgba(42, 38, 70, 0.98))',
      'shell-display-card-border': 'hsl(253 26% 42% / 0.72)',
      'shell-display-card-primary-bg':
        'linear-gradient(180deg, rgba(145, 110, 226, 0.98), rgba(82, 54, 150, 0.99))',
      'shell-display-card-primary-border': 'hsl(274 84% 80% / 0.72)',
      'shell-window-chrome-focused': 'hsl(251 22% 22%)',
      'shell-window-chrome-unfocused': 'hsl(247 18% 15%)',
      'shell-cursor-readout': 'hsl(272 84% 80%)',
      'shell-crosshair': 'hsl(276 88% 70% / 0.78)',
      'shell-scrollbar-track': 'hsl(248 28% 11% / 0.96)',
      'shell-scrollbar-thumb': 'hsl(257 22% 31% / 0.95)',
      'shell-scrollbar-thumb-hover': 'hsl(264 34% 44% / 0.98)',
    },
    light: {
      'shell-text': 'hsl(252 44% 14%)',
      'shell-text-muted': 'hsl(250 18% 31%)',
      'shell-text-dim': 'hsl(248 12% 46%)',
      'shell-text-strong': 'hsl(268 76% 34%)',
      'shell-text-mono': 'hsl(260 58% 38%)',
      'shell-border': 'hsl(258 26% 80% / 0.9)',
      'shell-border-strong': 'hsl(260 30% 68% / 0.94)',
      'shell-surface': 'hsl(260 40% 99% / 0.94)',
      'shell-surface-panel': 'hsl(258 48% 97% / 0.97)',
      'shell-surface-elevated': 'hsl(260 56% 99% / 0.98)',
      'shell-surface-inset': 'hsl(257 44% 93% / 0.94)',
      'shell-surface-hover': 'hsl(257 50% 94% / 0.98)',
      'shell-taskbar-bg': 'hsl(258 50% 95% / 0.97)',
      'shell-accent': 'hsl(270 76% 60%)',
      'shell-accent-hover': 'hsl(271 82% 54%)',
      'shell-accent-foreground': 'hsl(0 0% 100%)',
      'shell-accent-border': 'hsl(270 72% 52% / 0.72)',
      'shell-accent-soft': 'hsl(272 88% 92%)',
      'shell-accent-soft-border': 'hsl(270 74% 74% / 0.82)',
      'shell-accent-soft-text': 'hsl(268 74% 30%)',
      'shell-control-muted-bg': 'hsl(260 44% 100% / 0.92)',
      'shell-control-muted-hover': 'hsl(258 50% 93% / 0.98)',
      'shell-control-muted-text': 'hsl(252 38% 20%)',
      'shell-input-bg': 'hsl(260 46% 100% / 0.96)',
      'shell-input-border': 'hsl(258 24% 78% / 0.92)',
      'shell-input-focus': 'hsl(270 76% 58%)',
      'shell-overlay': 'hsl(260 52% 98% / 0.98)',
      'shell-overlay-border': 'hsl(258 28% 80% / 0.9)',
      'shell-overlay-hover': 'hsl(266 52% 94% / 0.96)',
      'shell-overlay-active': 'hsl(270 74% 89% / 0.98)',
      'shell-overlay-muted': 'hsl(270 60% 76% / 0.18)',
      'shell-warning-bg': 'hsl(293 64% 95%)',
      'shell-warning-border': 'hsl(286 72% 66% / 0.72)',
      'shell-warning-text': 'hsl(281 52% 28%)',
      'shell-preview-outline': 'hsl(279 86% 52% / 0.72)',
      'shell-preview-shadow': 'rgba(180, 77, 255, 0.16)',
      'shell-display-preview-bg': 'hsl(260 50% 96% / 0.98)',
      'shell-display-preview-glow':
        'radial-gradient(circle at top, rgba(168, 124, 255, 0.18), transparent 58%)',
      'shell-display-card-bg':
        'linear-gradient(180deg, rgba(245, 238, 255, 0.98), rgba(228, 216, 248, 0.99))',
      'shell-display-card-border': 'hsl(262 34% 74% / 0.88)',
      'shell-display-card-primary-bg':
        'linear-gradient(180deg, rgba(190, 154, 255, 0.96), rgba(139, 99, 224, 0.98))',
      'shell-display-card-primary-border': 'hsl(272 84% 62% / 0.74)',
      'shell-window-chrome-focused': 'hsl(262 34% 88%)',
      'shell-window-chrome-unfocused': 'hsl(260 32% 84%)',
      'shell-cursor-readout': 'hsl(270 78% 58%)',
      'shell-crosshair': 'hsl(272 82% 54% / 0.78)',
      'shell-scrollbar-track': 'hsl(260 44% 92% / 0.96)',
      'shell-scrollbar-thumb': 'hsl(264 26% 70% / 0.95)',
      'shell-scrollbar-thumb-hover': 'hsl(269 42% 58% / 0.98)',
    },
  },
}

export function resolveTheme(settings: ThemeSettings = getThemeSettings()): ResolvedTheme {
  const mode = resolveThemeMode(settings.mode, prefersDarkTheme())
  return {
    palette: settings.palette,
    mode,
    tokens: THEMES[settings.palette][mode],
  }
}

export function applyTheme(theme: ResolvedTheme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.shellThemePalette = theme.palette
  root.dataset.shellThemeMode = theme.mode
  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--${key}`, value)
  }
}

export function startThemeDomSync(): () => void {
  if (typeof window === 'undefined') return () => {}
  const sync = () => {
    applyTheme(resolveTheme(getThemeSettings()))
  }
  sync()
  const unsubscribe = subscribeThemeStore(() => {
    sync()
  })
  const media = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null
  const onMediaChange = () => {
    if (getThemeSettings().mode !== 'system') return
    sync()
  }
  if (media) {
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onMediaChange)
    } else if (typeof media.addListener === 'function') {
      media.addListener(onMediaChange)
    }
  }
  return () => {
    unsubscribe()
    if (!media) return
    if (typeof media.removeEventListener === 'function') {
      media.removeEventListener('change', onMediaChange)
    } else if (typeof media.removeListener === 'function') {
      media.removeListener(onMediaChange)
    }
  }
}
