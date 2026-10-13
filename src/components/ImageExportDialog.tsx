import { useEffect, useRef, useState } from "react";
import { canSharePreparedFile, downloadPreparedFile, sharePreparedFile, type DownloadResource } from "../core/fileDelivery";
import "./ImageExportDialog.css";

export function ImageExportDialog({ file, label, missingCovers, onClose }: {
  file: DownloadResource;
  label: string;
  missingCovers: number;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const shareAvailable = canSharePreparedFile(file);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);

  function save() {
    setError(null);
    try {
      downloadPreparedFile(file);
      setMessage("已发起保存。若浏览器没有下载，请打开原图后长按保存。");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法发起保存，请长按图片保存。");
    }
  }

  async function share() {
    if (sharing) return;
    setSharing(true); setError(null); setMessage(null);
    try {
      const result = await sharePreparedFile(file);
      setMessage(result === "shared" ? "已完成系统分享操作。" : "已取消分享，图片仍可保存。");
    } catch {
      setError("当前浏览器无法分享此图片，请点击保存 PNG，或打开原图后长按保存。");
    } finally { setSharing(false); }
  }

  return <dialog ref={dialog} className="image-export-dialog" aria-labelledby="image-export-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="image-export-content">
      <header className="image-export-heading">
        <div><span className="eyebrow">IMAGE EXPORT</span><h2 id="image-export-title">{label} 图片预览</h2></div>
        <button type="button" className="image-export-close" aria-label="关闭图片预览" onClick={onClose}>×</button>
      </header>
      <p className="image-export-note">图片已生成。手机可长按图片保存，也可以使用下方保存按钮。</p>
      {missingCovers > 0 && <p className="image-export-note">{missingCovers} 张曲绘加载失败，已使用占位图。</p>}
      <div className="image-export-preview"><img src={file.url} alt={`${label} 分表，包含分数、Rating、评级和达成标记`} /></div>
      <div className="image-export-footer">
        <div className="image-export-actions">
          <button type="button" className="primary" onClick={save}>保存 PNG</button>
          {shareAvailable && <button type="button" disabled={sharing} onClick={() => { void share(); }}>{sharing ? "正在分享…" : "分享图片"}</button>}
          <a href={file.url} target="_blank" rel="noopener noreferrer">打开原图</a>
        </div>
        <small>{file.filename} · {(file.blob.size / 1024 / 1024).toFixed(2)} MB</small>
        {message && <p className="image-export-feedback" role="status">{message}</p>}
        {error && <p className="image-export-error" role="alert">{error}</p>}
      </div>
    </div>
  </dialog>;
}
