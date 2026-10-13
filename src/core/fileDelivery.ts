// Keep generated images available for preview, long-press saving and a fresh
// user click. Browser download requests do not confirm a file was saved.
export interface DownloadResource {
  readonly blob: Blob;
  readonly filename: string;
  readonly url: string;
  readonly disposed: boolean;
  dispose(): void;
}

const DOWNLOAD_RELEASE_DELAY_MS = 60_000;
const lastDownloadRequests = new WeakMap<DownloadResource, number>();

export function createDownloadResource(blob: Blob, filename: string): DownloadResource {
  const url = URL.createObjectURL(blob);
  let disposed = false;
  const resource: DownloadResource = {
    blob,
    filename,
    url,
    get disposed() { return disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      const requestedAt = lastDownloadRequests.get(resource);
      const delay = requestedAt === undefined ? 0 : Math.max(0, DOWNLOAD_RELEASE_DELAY_MS - (Date.now() - requestedAt));
      // Mobile browsers may still be handing the blob to their download UI.
      if (delay > 0) window.setTimeout(() => URL.revokeObjectURL(url), delay);
      else URL.revokeObjectURL(url);
      lastDownloadRequests.delete(resource);
    },
  };
  return resource;
}

export function downloadPreparedFile(resource: DownloadResource): void {
  if (resource.disposed) throw new Error("文件预览已关闭，请重新生成。");
  const anchor = document.createElement("a");
  anchor.href = resource.url;
  anchor.download = resource.filename;
  document.body.append(anchor);
  try {
    lastDownloadRequests.set(resource, Date.now());
    anchor.click();
  } finally {
    anchor.remove();
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const resource = createDownloadResource(blob, filename);
  try {
    downloadPreparedFile(resource);
  } finally {
    resource.dispose();
  }
}

function shareFile(resource: DownloadResource): File {
  return new File([resource.blob], resource.filename, { type: resource.blob.type });
}

export function canSharePreparedFile(resource: DownloadResource): boolean {
  if (resource.disposed || globalThis.isSecureContext === false || typeof navigator === "undefined"
    || typeof navigator.share !== "function" || typeof navigator.canShare !== "function" || typeof File === "undefined") return false;
  try {
    return navigator.canShare({ files: [shareFile(resource)] });
  } catch {
    return false;
  }
}

export async function sharePreparedFile(resource: DownloadResource): Promise<"shared" | "cancelled"> {
  if (!canSharePreparedFile(resource)) throw new Error("当前浏览器不支持图片分享，请点击保存图片或长按预览保存。");
  try {
    // No asynchronous work before share(): it needs the current click's activation.
    await navigator.share({ files: [shareFile(resource)], title: "MACHUN1 B30" });
    return "shared";
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") return "cancelled";
    throw error;
  }
}
