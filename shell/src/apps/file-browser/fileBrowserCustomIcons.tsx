import type { Component, JSX } from 'solid-js'
import Archive from 'lucide-solid/icons/archive'
import BookOpen from 'lucide-solid/icons/book-open'
import Briefcase from 'lucide-solid/icons/briefcase'
import Code2 from 'lucide-solid/icons/code-2'
import FileText from 'lucide-solid/icons/file-text'
import Folder from 'lucide-solid/icons/folder'
import Heart from 'lucide-solid/icons/heart'
import Home from 'lucide-solid/icons/home'
import Image from 'lucide-solid/icons/image'
import Music from 'lucide-solid/icons/music'
import Star from 'lucide-solid/icons/star'
import Video from 'lucide-solid/icons/video'

export type FileBrowserCustomIconDef = {
  name: string
  label: string
  Icon: Component<{ class?: string; 'stroke-width'?: number }>
}

export const FILE_BROWSER_CUSTOM_ICONS: FileBrowserCustomIconDef[] = [
  { name: 'folder', label: 'Folder', Icon: Folder },
  { name: 'star', label: 'Star', Icon: Star },
  { name: 'heart', label: 'Heart', Icon: Heart },
  { name: 'home', label: 'Home', Icon: Home },
  { name: 'briefcase', label: 'Work', Icon: Briefcase },
  { name: 'book-open', label: 'Notes', Icon: BookOpen },
  { name: 'file-text', label: 'Text', Icon: FileText },
  { name: 'code-2', label: 'Code', Icon: Code2 },
  { name: 'image', label: 'Image', Icon: Image },
  { name: 'video', label: 'Video', Icon: Video },
  { name: 'music', label: 'Audio', Icon: Music },
  { name: 'archive', label: 'Archive', Icon: Archive },
]

const iconsByName = new Map(FILE_BROWSER_CUSTOM_ICONS.map((icon) => [icon.name, icon]))

export function fileBrowserCustomIcon(name: string | null | undefined): FileBrowserCustomIconDef | null {
  if (!name) return null
  return iconsByName.get(name) ?? null
}

export function renderFileBrowserCustomIcon(
  name: string | null | undefined,
  className = 'h-4 w-4',
): JSX.Element | null {
  const def = fileBrowserCustomIcon(name)
  if (!def) return null
  const Icon = def.Icon
  return <Icon class={className} stroke-width={2} />
}
