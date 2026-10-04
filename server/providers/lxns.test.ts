import { describe, expect, it, vi } from "vitest";
import { LxnsProvider } from "./lxns";

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status === 200, data }), { status });
}

describe("LXNS backend adapter", () => {
  it("verifies the bound identity and only reads score fields", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply({ friend_code: 123, name: "玩家" }))
      .mockResolvedValueOnce(reply([{ id: 1, level_index: 3, score: 1_000_000, secret: "not-returned" }]));
    const result = await new LxnsProvider(fetcher).fetchScores("token", { id: "123", label: "玩家" });
    expect(result).toEqual([{ id: 1, level_index: 3, score: 1_000_000, play_time: undefined, upload_time: undefined }]);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: "error", headers: { "X-User-Token": "token" } });
  });

  it("rejects account changes before requesting scores", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ friend_code: 456, name: "另一账号" }));
    await expect(new LxnsProvider(fetcher).fetchScores("token", { id: "123", label: "玩家" })).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([{}, [], { id: 1, level_index: 3 }, { id: 1, level_index: 3, score: -1 }])("rejects malformed score entries instead of reporting an empty success: %j", async (entry) => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ friend_code: 123, name: "玩家" })).mockResolvedValueOnce(reply([entry]));
    await expect(new LxnsProvider(fetcher).fetchScores("token", { id: "123", label: "玩家" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each(["", -1, 1.2, "not-a-code"])("rejects malformed player IDs: %j", async (friend_code) => {
    await expect(new LxnsProvider(vi.fn().mockResolvedValue(reply({ friend_code }))).identify("token")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("distinguishes expired tokens, invalid responses, and network errors without leaking upstream messages", async () => {
    await expect(new LxnsProvider(vi.fn().mockResolvedValue(reply(null, 401))).identify("private-token")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(new LxnsProvider(vi.fn().mockResolvedValue(new Response("not json"))).identify("private-token")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(new LxnsProvider(vi.fn().mockRejectedValue(new Error("URL with private-token"))).identify("private-token")).rejects.toMatchObject({ code: "NETWORK_ERROR", message: "落雪连接失败或超时，请稍后重试。" });
  });
});
