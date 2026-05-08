import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { shellHttpBase } from "@/features/bridge/shellHttp";
import type { ShellCompositorWireSend } from "@/features/shell-ui/shellWireSendType";

export type NativeDragPreview = {
  window_id: number;
  generation: number;
  image_path: string;
};

function nativeDragPreviewUrl(imagePath: string, generation: number) {
  const base = shellHttpBase();
  if (!base) return "";
  return `${base}/native_drag_preview?p=${encodeURIComponent(imagePath)}&g=${generation}`;
}

export function createNativeDragPreviewRuntime(
  nativeDragPreview: () => NativeDragPreview | null,
  shellWireSend: ShellCompositorWireSend,
) {
  const [loadedNativeDragPreviewKey, setLoadedNativeDragPreviewKey] =
    createSignal<string | null>(null);
  const [loadedNativeDragPreviewImage, setLoadedNativeDragPreviewImage] =
    createSignal<HTMLImageElement | null>(null);
  const nativeDragPreviewKey = createMemo(() => {
    const preview = nativeDragPreview();
    return preview
      ? `${preview.window_id}:${preview.generation}:${preview.image_path}`
      : null;
  });
  const nativeDragPreviewWindowId = createMemo(
    () => nativeDragPreview()?.window_id ?? null,
  );
  const nativeDragPreviewGeneration = createMemo(
    () => nativeDragPreview()?.generation ?? null,
  );
  const nativeDragPreviewSrc = createMemo(() => {
    const preview = nativeDragPreview();
    if (!preview) return "";
    return nativeDragPreviewUrl(preview.image_path, preview.generation);
  });
  createEffect(() => {
    const key = nativeDragPreviewKey();
    const windowId = nativeDragPreviewWindowId();
    const generation = nativeDragPreviewGeneration();
    const src = nativeDragPreviewSrc();
    setLoadedNativeDragPreviewKey(null);
    setLoadedNativeDragPreviewImage(null);
    if (!key || windowId === null || generation === null || !src) return;
    let cancelled = false;
    let loaded = false;
    const image = new Image();
    const markLoaded = () => {
      if (cancelled || loaded) return;
      loaded = true;
      setLoadedNativeDragPreviewImage(image);
      setLoadedNativeDragPreviewKey(key);
      shellWireSend("native_drag_preview_ready", windowId, generation);
    };
    image.onload = markLoaded;
    image.src = src;
    if (image.complete && image.naturalWidth > 0) markLoaded();
    onCleanup(() => {
      cancelled = true;
      image.onload = null;
    });
  });
  return createMemo(() => {
    const preview = nativeDragPreview();
    const key = nativeDragPreviewKey();
    const src = nativeDragPreviewSrc();
    if (!preview || !key || !src) return null;
    const image = loadedNativeDragPreviewImage();
    const loaded = loadedNativeDragPreviewKey() === key && image !== null;
    return {
      ...preview,
      src,
      loaded,
      image: loaded ? image : null,
    };
  });
}
