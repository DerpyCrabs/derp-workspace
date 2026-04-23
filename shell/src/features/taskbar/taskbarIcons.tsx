import AppWindow from 'lucide-solid/icons/app-window'
import Code2 from 'lucide-solid/icons/code-2'
import FileText from 'lucide-solid/icons/file-text'
import FolderOpen from 'lucide-solid/icons/folder-open'
import Gamepad2 from 'lucide-solid/icons/gamepad-2'
import Globe from 'lucide-solid/icons/globe'
import Image from 'lucide-solid/icons/image'
import Mail from 'lucide-solid/icons/mail'
import MessageSquare from 'lucide-solid/icons/message-square'
import Monitor from 'lucide-solid/icons/monitor'
import Music4 from 'lucide-solid/icons/music-4'
import Settings from 'lucide-solid/icons/settings'
import SquareTerminal from 'lucide-solid/icons/square-terminal'
import Video from 'lucide-solid/icons/video'
import { createEffect, type Component } from 'solid-js'
import { renderFileBrowserCustomIcon } from '@/apps/file-browser/fileBrowserCustomIcons'
import { useFileBrowserFilesSettings } from '@/apps/file-browser/fileBrowserFilesSettings'

export type TaskbarIconMeta = {
  title: string
  appId: string
  desktopId?: string | null
  desktopIcon?: string | null
  shellFilePath?: string | null
}

function normalizedKey(meta: TaskbarIconMeta) {
  return [meta.desktopIcon, meta.desktopId, meta.appId, meta.title]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase()
}

function chooseIcon(meta: TaskbarIconMeta): Component<{ class?: string; 'stroke-width'?: number }> | null {
  const key = normalizedKey(meta)
  if (
    key.includes('firefox') ||
    key.includes('chrome') ||
    key.includes('chromium') ||
    key.includes('zen') ||
    key.includes('browser') ||
    key.includes('web')
  ) {
    return Globe
  }
  if (
    key.includes('kitty') ||
    key.includes('wezterm') ||
    key.includes('alacritty') ||
    key.includes('gnome-terminal') ||
    key.includes('console') ||
    key.includes('terminal') ||
    key.includes('xterm')
  ) {
    return SquareTerminal
  }
  if (
    key.includes('thunar') ||
    key.includes('nautilus') ||
    key.includes('dolphin') ||
    key.includes('pcmanfm') ||
    key.includes('files') ||
    key.includes('folder')
  ) {
    return FolderOpen
  }
  if (key.includes('settings') || key.includes('control center')) {
    return Settings
  }
  if (key.includes('display') || key.includes('monitor')) {
    return Monitor
  }
  if (key.includes('mail') || key.includes('thunderbird')) {
    return Mail
  }
  if (key.includes('signal') || key.includes('discord') || key.includes('slack') || key.includes('chat')) {
    return MessageSquare
  }
  if (key.includes('music') || key.includes('spotify') || key.includes('rhythmbox')) {
    return Music4
  }
  if (key.includes('video') || key.includes('vlc') || key.includes('mpv') || key.includes('youtube')) {
    return Video
  }
  if (key.includes('image') || key.includes('photo') || key.includes('gimp') || key.includes('krita')) {
    return Image
  }
  if (
    key.includes('code') ||
    key.includes('cursor') ||
    key.includes('vscode') ||
    key.includes('editor') ||
    key.includes('nvim') ||
    key.includes('emacs')
  ) {
    return Code2
  }
  if (key.includes('steam') || key.includes('game') || key.includes('heroic')) {
    return Gamepad2
  }
  if (key.includes('.md') || key.includes('.txt') || key.includes('notes') || key.includes('document')) {
    return FileText
  }
  if (key.includes('window') || key.includes('app')) {
    return AppWindow
  }
  return null
}

function monogram(meta: TaskbarIconMeta): string {
  const source = [meta.title, meta.desktopId, meta.appId]
    .find((value) => typeof value === 'string' && value.trim().length > 0)
    ?.trim()
  if (!source) return '?'
  const letters = source
    .replace(/\.desktop$/i, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
  return letters || source[0]!.toUpperCase()
}

function accentColor(meta: TaskbarIconMeta): string {
  const key = normalizedKey(meta) || 'app'
  let hash = 0
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 33 + key.charCodeAt(i)) >>> 0
  }
  return `hsl(${hash % 360} 55% 32%)`
}

export function TaskbarWindowIcon(props: {
  meta: TaskbarIconMeta
  active: boolean
  compact?: boolean
}) {
  const filesSettings = useFileBrowserFilesSettings()
  createEffect(() => {
    if (!props.meta.shellFilePath) return
    void filesSettings.warm()
  })
  const Icon = chooseIcon(props.meta)
  const sizeClass = props.compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'
  const customIcon = () => {
    const path = props.meta.shellFilePath
    if (!path) return null
    const icons = filesSettings.settings().custom_icons
    const key = path.replace(/\\/g, '/')
    return renderFileBrowserCustomIcon(icons[path] ?? icons[key] ?? null, sizeClass)
  }
  return (
    <span
      class="flex shrink-0 items-center justify-center rounded-md text-white shadow-sm"
      style={{
        width: props.compact ? '18px' : '20px',
        height: props.compact ? '18px' : '20px',
        'background-color': accentColor(props.meta),
        opacity: props.active ? '1' : '0.92',
      }}
      aria-hidden="true"
    >
      {customIcon() ? (
        customIcon()
      ) : Icon ? (
        <Icon class={sizeClass} stroke-width={2.2} />
      ) : (
        <span class="text-[10px] font-semibold leading-none">{monogram(props.meta)}</span>
      )}
    </span>
  )
}
