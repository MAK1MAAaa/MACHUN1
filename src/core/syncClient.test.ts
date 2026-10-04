import { describe, expect, it, vi } from "vitest";
import type { SourceConnection, SyncResult } from "../syncTypes";
import { createSyncClient, LOCAL_SERVICE_MESSAGE } from "./syncClient";

const connection: SourceConnection = {
  source: "rin", status: "ready", bound: true, identity: { id: "player", label: "玩家", cardId: "123" },
  lastAttemptAt: null, lastSuccessAt: null, error: null,
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("local source sync client", () => {
  it("restores source connection states from the local service", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ sources: [connection] }));
    expect(await createSyncClient(fetcher).list()).toEqual([connection]);
    expect(fetcher).toHaveBeenCalledWith("/api/sources", { method: "GET", headers: { Accept: "application/json" } });
  });

  it("accepts asynchronous browser binding and sends required local request headers", async () => {
    const binding = { ...connection, status: "binding", bound: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ connection: binding }, 202));
    expect(await createSyncClient(fetcher).bind("rin")).toEqual(binding);
    expect(fetcher).toHaveBeenCalledWith("/api/sources/rin/bind", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Machun-Request": "1" },
      body: "{}",
    });
  });

  it("submits a token only when binding LXNS, never when syncing later", async () => {
    const ready = { ...connection, source: "lxns" };
    const result: SyncResult = {
      source: "lxns", connection: { ...connection, source: "lxns" }, records: [],
      report: { parsedScores: 0, importedScores: 0, updatedScores: 0, skippedScores: 0, unknownCharts: 0, invalidEntries: 0 },
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ connection: ready }))
      .mockResolvedValueOnce(response(result));
    const client = createSyncClient(fetcher);
    await client.bind("lxns", "  example-token  ");
    expect(await client.sync("lxns")).toEqual(result);
    expect(fetcher.mock.calls[0]).toEqual(["/api/sources/lxns/bind", expect.objectContaining({ body: '{"token":"example-token"}' })]);
    expect(fetcher.mock.calls[1]).toEqual(["/api/sources/lxns/sync", expect.objectContaining({ body: "{}", method: "POST" })]);
    expect(JSON.stringify(fetcher.mock.calls[1])).not.toContain("example-token");
  });

  it("rejects an empty token before sending a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createSyncClient(fetcher).bind("lxns", "  ")).rejects.toMatchObject({ code: "token_required" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the explicit full-calibration option only when requested", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ records: [] }));
    await createSyncClient(fetcher).sync("otogame", { full: true });
    expect(fetcher).toHaveBeenCalledWith("/api/sources/otogame/sync", expect.objectContaining({ method: "POST", body: '{"full":true}' }));
  });

  it("deletes the binding with the required write headers", async () => {
    const unbound = { ...connection, bound: false, status: "unbound", identity: null };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ connection: unbound }));
    expect(await createSyncClient(fetcher).unbind("rin")).toEqual(unbound);
    expect(fetcher).toHaveBeenCalledWith("/api/sources/rin/binding", {
      method: "DELETE",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Machun-Request": "1" },
      body: "{}",
    });
  });

  it("preserves server errors for actionable source status", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ code: "auth_required", error: "登录已失效，请重新登录" }, 401));
    await expect(createSyncClient(fetcher).sync("rin")).rejects.toMatchObject({ code: "auth_required", message: "登录已失效，请重新登录" });
  });

  it("explains how to start the service when offline or served without a backend", async () => {
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(createSyncClient(offline).list()).rejects.toThrow(LOCAL_SERVICE_MESSAGE);
    const frontendOnly = vi.fn<typeof fetch>().mockResolvedValue(new Response("<!doctype html><html></html>"));
    await expect(createSyncClient(frontendOnly).list()).rejects.toThrow(LOCAL_SERVICE_MESSAGE);
    const wrongService = vi.fn<typeof fetch>().mockResolvedValue(response({ unrelated: [] }));
    await expect(createSyncClient(wrongService).list()).rejects.toThrow(LOCAL_SERVICE_MESSAGE);
  });
});
