import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canSharePreparedFile, createDownloadResource, downloadBlob, downloadPreparedFile, sharePreparedFile } from "./fileDelivery";
import { downloadB30Json } from "./b30Export";
import { createFullBackup, downloadFullBackup } from "./backup";
import { EMPTY_STATE } from "./storage";

describe("generated file delivery", () => {
  const createObjectURL = vi.fn((_blob: Blob) => "blob:prepared-image");
  const revokeObjectURL = vi.fn();
  const click = vi.fn();
  const remove = vi.fn();
  const append = vi.fn();
  const createElement = vi.fn(() => ({ href: "", download: "", click, remove }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    vi.clearAllMocks();
    vi.stubGlobal("window", { setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args) });
    vi.stubGlobal("document", { createElement, body: { append } });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("isSecureContext", true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps an image preview available until it is closed, without starting a download", () => {
    const blob = new Blob(["png"], { type: "image/png" });
    const resource = createDownloadResource(blob, "b30.png");
    vi.advanceTimersByTime(120_000);
    expect(resource).toMatchObject({ blob, url: "blob:prepared-image", filename: "b30.png", disposed: false });
    expect(createElement).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    resource.dispose();
    resource.dispose();
    expect(resource.disposed).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:prepared-image");
  });

  it("requests a download synchronously on the new click and allows a slow browser to finish after preview cleanup", () => {
    const resource = createDownloadResource(new Blob(["png"]), "b30.png");
    downloadPreparedFile(resource);
    const anchor = createElement.mock.results[0].value;
    expect(anchor).toMatchObject({ href: resource.url, download: "b30.png" });
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    resource.dispose();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59_999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(() => downloadPreparedFile(resource)).toThrow("文件预览已关闭");
  });

  it("extends the URL lifetime from the latest download request", () => {
    const resource = createDownloadResource(new Blob(["png"]), "b30.png");
    downloadPreparedFile(resource);
    vi.advanceTimersByTime(50_000);
    downloadPreparedFile(resource);
    vi.advanceTimersByTime(30_000);
    resource.dispose();
    vi.advanceTimersByTime(29_999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("keeps synchronous JSON downloads and full backup files compatible", async () => {
    downloadB30Json([], true);
    expect(click).toHaveBeenCalledOnce();
    const jsonBlob = createObjectURL.mock.calls[0][0] as Blob;
    expect(jsonBlob.type).toBe("application/json");
    expect(JSON.parse(await jsonBlob.text()).data.next_rating_list).toEqual([]);
    expect(createElement.mock.results[0].value.download).toBe("b30-candidates20.json");

    const backup = createFullBackup(EMPTY_STATE, "test");
    downloadFullBackup(backup);
    expect(createElement.mock.results[1].value.download).toBe("machun1-backup.json");
    expect(JSON.parse(await (createObjectURL.mock.calls[1][0] as Blob).text())).toEqual(backup);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("releases a one-shot download even when the browser throws", () => {
    click.mockImplementationOnce(() => { throw new Error("blocked"); });
    expect(() => downloadBlob(new Blob(), "backup.json")).toThrow("blocked");
    expect(remove).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("calls native file sharing before yielding the click activation", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn(() => true);
    vi.stubGlobal("navigator", { share, canShare });
    const resource = createDownloadResource(new Blob(["png"], { type: "image/png" }), "b30.png");
    expect(canSharePreparedFile(resource)).toBe(true);
    const result = sharePreparedFile(resource);
    expect(share).toHaveBeenCalledOnce();
    const sharedFile = share.mock.calls[0][0].files[0] as File;
    expect(sharedFile).toMatchObject({ name: "b30.png", type: "image/png" });
    expect(await sharedFile.text()).toBe("png");
    expect(await result).toBe("shared");
    expect(click).not.toHaveBeenCalled();
    expect(resource.disposed).toBe(false);
  });

  it("treats cancelling share as cancellation and leaves the preview available", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError"));
    vi.stubGlobal("navigator", { share, canShare: () => true });
    const resource = createDownloadResource(new Blob(["png"]), "b30.png");
    expect(await sharePreparedFile(resource)).toBe("cancelled");
    expect(resource.disposed).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("preserves the preview on share failure and does not silently request a download", async () => {
    const failure = new DOMException("no activation", "NotAllowedError");
    const share = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("navigator", { share, canShare: () => true });
    const resource = createDownloadResource(new Blob(["png"]), "b30.png");
    await expect(sharePreparedFile(resource)).rejects.toBe(failure);
    expect(resource.disposed).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });

  it("offers download/long-press fallback when file sharing is unavailable or HTTP is insecure", async () => {
    const resource = createDownloadResource(new Blob(["png"]), "b30.png");
    expect(canSharePreparedFile(resource)).toBe(false);
    await expect(sharePreparedFile(resource)).rejects.toThrow("点击保存图片或长按预览保存");
    vi.stubGlobal("navigator", { share: vi.fn(), canShare: () => true });
    vi.stubGlobal("isSecureContext", false);
    expect(canSharePreparedFile(resource)).toBe(false);
  });

  it("hides file sharing if capability checking throws or the resource was disposed", () => {
    const resource = createDownloadResource(new Blob(["png"]), "b30.png");
    vi.stubGlobal("navigator", { share: vi.fn(), canShare: () => { throw new Error("unavailable"); } });
    expect(canSharePreparedFile(resource)).toBe(false);
    vi.stubGlobal("navigator", { share: vi.fn(), canShare: () => true });
    resource.dispose();
    expect(canSharePreparedFile(resource)).toBe(false);
  });
});
