import { describe, expect, it } from "vitest";
import { parseEnv } from "node:util";
import { configuredLoginCredentials, runtimeConfig } from "./config";

describe("optional portal login credentials", () => {
  it("shares the BCN pair between Rin and OTO and keeps MuNET credentials separate", () => {
    const environment = parseEnv([
      'BCN_EMAIL="  fixture@example.test  "',
      'BCN_PASSWORD="  fixture # bcn  "',
      'MUNET_USERNAME=fixture-munet',
      'MUNET_PASSWORD="fixture # munet"',
    ].join("\n"));
    const bcn = { username: "fixture@example.test", password: "  fixture # bcn  " };
    expect(configuredLoginCredentials(environment)).toEqual({
      rin: bcn,
      otogame: bcn,
      munet: { username: "fixture-munet", password: "fixture # munet" },
    });
  });

  it("leaves incomplete or malformed pairs in manual login mode", () => {
    expect(configuredLoginCredentials({})).toEqual({});
    expect(configuredLoginCredentials({ BCN_EMAIL: "fixture@example.test", MUNET_PASSWORD: "fixture" })).toEqual({});
    expect(configuredLoginCredentials({
      BCN_EMAIL: "fixture@example.test", BCN_PASSWORD: "fixture\npassword",
      MUNET_USERNAME: " ", MUNET_PASSWORD: "fixture",
    })).toEqual({});
  });
});

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
