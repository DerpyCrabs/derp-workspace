import { createStore } from 'solid-js/store'

export type FileBrowserFsClipMode = 'none' | 'copy' | 'cut'

export type FileBrowserFsClipState = {
  mode: FileBrowserFsClipMode
  path: string | null
}

const [fsClip, setFsClip] = createStore<FileBrowserFsClipState>({
  mode: 'none',
  path: null,
})

export function fileBrowserFsClipState(): FileBrowserFsClipState {
  return fsClip
}

export function fileBrowserFsClipCopy(path: string) {
  setFsClip({ mode: 'copy', path })
}

export function fileBrowserFsClipCut(path: string) {
  setFsClip({ mode: 'cut', path })
}

export function fileBrowserFsClipClear() {
  setFsClip({ mode: 'none', path: null })
}
