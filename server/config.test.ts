import { describe, expect, it } from "vitest";
import { runtimeConfig } from "./config";

describe("local runtime configuration", () => {
  it("uses the local development, production and preview ports", () => {
    expect(runtimeConfig({}, "/project")).toEqual({
      host: "127.0.0.1", development: false, port: 4399, dataDirectory: "/project/.machun.local",
    });
    expect(runtimeConfig({ MACHUN_PORT: "1650" }, "/project", ["--dev"]).port).toBe(4398);
    expect(runtimeConfig({}, "/project", ["--preview"]).port).toBe(4400);
    expect(runtimeConfig({ MACHUN_PORT: "4500", MACHUN_DATA_DIR: "./private" }, "/project"))
      .toMatchObject({ port: 4500, dataDirectory: "/project/private" });
  });

  it("stays on loopback with old deployment environment variables present", () => {
    expect(runtimeConfig({
      MACHUN_LISTEN_HOST: "0.0.0.0",
      MACHUN_PUBLIC_ORIGIN: "https://scores.example",
      MACHUN_BINDING_MODE: "companion",
    }, "/project").host).toBe("127.0.0.1");
  });

  it.each(["0", "-1", "1.5", "65536", "invalid"])("rejects invalid port %s", port => {
    expect(() => runtimeConfig({ MACHUN_PORT: port }, "/project")).toThrow("MACHUN_PORT");
  });

  it.each([".", "..", "/project/dist/private", "public/data"])("rejects unsafe data directory %s", directory => {
    expect(() => runtimeConfig({ MACHUN_DATA_DIR: directory }, "/project")).toThrow("MACHUN_DATA_DIR");
  });
});
