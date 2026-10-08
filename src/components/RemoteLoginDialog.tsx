import { useEffect, useId, useRef } from "react";
import { SCORE_SOURCE_LABELS, type ExternalScoreSource } from "../core/sources";

export function isLocalLoginUrl(value?: string): value is string {
  return Boolean(value && /^\/login-view\/vnc\.html\?[^#]*$/.test(value));
}

export function RemoteLoginDialog({ source, url, onClose }: { source: ExternalScoreSource; url: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => { dialog.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  if (!isLocalLoginUrl(url)) return null;
  return <dialog ref={dialogRef} className="remote-login-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header>
      <div><h2 id={titleId}>{SCORE_SOURCE_LABELS[source]}账号登录</h2><p>在窗口内手动登录并完成验证码。绑定成功后自动返回成绩页面。</p></div>
      <button type="button" onClick={onClose} autoFocus>返回成绩页面</button>
    </header>
    <iframe src={url} title={`${SCORE_SOURCE_LABELS[source]}手动登录窗口`} allowFullScreen />
    <p className="remote-login-tip">手机输入可使用窗口左侧工具栏的键盘；返回页面不会取消绑定，可再次打开窗口。</p>
  </dialog>;
}
