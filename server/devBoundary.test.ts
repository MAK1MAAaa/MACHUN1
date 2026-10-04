import { describe, expect, it } from "vitest";
import { resolveConfig, isFileServingAllowed } from "vite";
import { resolve } from "node:path";

describe("Vite development credential protection", () => {
  it("blocks local credentials and browser storage through normal and @fs paths", async () => {
    const config = await resolveConfig({}, "serve");
    for (const path of [".env", ".env.local", ".machun.local/lxns.json", ".machun.local/profiles/rin-test/Default/Local Storage/leveldb/000001.log"]) {
      const absolute = resolve(config.root, path);
      expect(isFileServingAllowed(config, absolute)).toBe(false);
      expect(isFileServingAllowed(config, `/@fs/${absolute}`)).toBe(false);
    }
    expect(isFileServingAllowed(config, resolve(config.root, "src/App.tsx"))).toBe(true);
  });
});
