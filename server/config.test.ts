import { describe, expect, it } from "vitest";
import { runtimeConfig } from "./config";

describe("runtime deployment configuration", () => {
  it("keeps localhost and the existing data directory as defaults", () => {
    expect(runtimeConfig({}, "/project")).toMatchObject({ host: "127.0.0.1", port: 4399, dataDirectory: "/project/.machun.local", companionLogin: false });
    expect(runtimeConfig({}, "/project", ["--dev"]).port).toBe(4398);
    expect(runtimeConfig({}, "/project", ["--preview"]).port).toBe(4400);
  });
  it("supports direct IP deployment without an origin and keeps an explicit origin restricted", () => {
    expect(runtimeConfig({ MACHUN_LISTEN_HOST: '0.0.0.0', MACHUN_PORT: '1650' }, '/project')).toMatchObject({ publicOrigin: undefined, publicIpAccess: true });
    expect(runtimeConfig({}, '/project').publicIpAccess).toBe(false);
    expect(runtimeConfig({ MACHUN_LISTEN_HOST: '0.0.0.0', MACHUN_PUBLIC_ORIGIN: 'http://scores.example:1650' }, '/project')).toMatchObject({ publicOrigin: 'http://scores.example:1650', publicIpAccess: false });
    expect(runtimeConfig({ MACHUN_LISTEN_HOST: '0.0.0.0', MACHUN_PORT: '1650', MACHUN_PUBLIC_ORIGIN: 'https://scores.example/', MACHUN_BINDING_MODE: 'companion', MACHUN_DATA_DIR: '/data' }, '/project')).toMatchObject({ port: 1650, publicOrigin: 'https://scores.example', publicIpAccess: false, companionLogin: true, dataDirectory: '/data' });
  });
  it.each(["file:///tmp", "https://user:secret@example.com", "https://example.com/app", "https://example.com/?token=private", "https://example.com/#token", "private-invalid-origin"])("rejects malformed or unsafe origins without echoing them: %s", (origin) => {
    expect(() => runtimeConfig({ MACHUN_PUBLIC_ORIGIN: origin }, "/project")).toThrow("MACHUN_PUBLIC_ORIGIN");
    try { runtimeConfig({ MACHUN_PUBLIC_ORIGIN: origin }, "/project"); } catch (error) { expect(String(error)).not.toContain("private"); }
  });
  it.each(["0", "65536", "3.1", "bad"])("rejects invalid port %s", (port) => {
    expect(() => runtimeConfig({ MACHUN_PORT: port }, "/project")).toThrow("MACHUN_PORT");
  });
  it("does not accept arbitrary listen addresses", () => {
    expect(() => runtimeConfig({ MACHUN_LISTEN_HOST: "192.168.1.1" }, "/project")).toThrow("MACHUN_LISTEN_HOST");
  });
});
