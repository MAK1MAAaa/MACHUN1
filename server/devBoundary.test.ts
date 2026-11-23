import { describe, expect, it, vi } from "vitest";
import { resolveConfig, isFileServingAllowed } from "vite";
import { resolve } from "node:path";

describe("Vite development credential protection", () => {
  it("blocks local credentials and browser storage through normal and @fs paths", async () => {
    const config = await resolveConfig({}, "serve");
    for (const path of [".env", ".env.local", ".machun.local/machun1.sqlite", ".machun.local/machun1.sqlite-journal", ".machun.local/profiles/rin-test/Default/Local Storage/leveldb/000001.log"]) {
      const absolute = resolve(config.root, path);
      expect(isFileServingAllowed(config, absolute)).toBe(false);
      expect(isFileServingAllowed(config, `/@fs/${absolute}`)).toBe(false);
    }
    expect(isFileServingAllowed(config, resolve(config.root, "src/App.tsx"))).toBe(true);
  });

  it("blocks arbitrary files in a configured data directory", async () => {
    vi.stubEnv("MACHUN_DATA_DIR", "private [profiles]");
    try {
      const config = await resolveConfig({}, "serve");
      for (const file of ["machun1.sqlite", "profiles/Default/Cookies"]) {
        const path = resolve(config.root, "private [profiles]", file);
        expect(isFileServingAllowed(config, path)).toBe(false);
        expect(isFileServingAllowed(config, `/@fs/${path}`)).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
