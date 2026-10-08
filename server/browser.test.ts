import { describe, expect, it, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launchPersistentContext: mocks.launch } }));
import { browserLauncher, createBrowserLauncher } from "./browser";

beforeEach(() => { mocks.launch.mockReset(); });

function context() {
  const page = { goto: vi.fn().mockResolvedValue(undefined) };
  return { page, value: { pages: () => [page], setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(), close: vi.fn().mockResolvedValue(undefined) } };
}

describe("dedicated browser launcher", () => {
  it("opens manual binding windows and reuses profiles headlessly for sync", async () => {
    const fake = context();
    mocks.launch.mockResolvedValue(fake.value);
    const launcher = createBrowserLauncher();
    await launcher.open("/private/tmp/machun-test-only", "https://bemanicn.com/login", false);
    expect(mocks.launch).toHaveBeenLastCalledWith("/private/tmp/machun-test-only", expect.objectContaining({ headless: true }));
    await launcher.open("/private/tmp/machun-test-only", "https://bemanicn.com/login", true);
    expect(mocks.launch).toHaveBeenLastCalledWith("/private/tmp/machun-test-only", expect.objectContaining({ headless: false }));
    expect(fake.page.goto).toHaveBeenCalledTimes(2);
  });

  it("falls back to installed Chrome with the same isolated directory when Chromium is missing", async () => {
    const fake = context();
    mocks.launch.mockRejectedValueOnce(new Error("Executable doesn't exist at test-browser")).mockResolvedValueOnce(fake.value);
    await browserLauncher.open("/private/tmp/machun-test-only", "https://example.com/login", true);
    expect(mocks.launch).toHaveBeenLastCalledWith("/private/tmp/machun-test-only", expect.objectContaining({ channel: "chrome", headless: false }));
    expect(fake.page.goto).toHaveBeenCalledWith("https://example.com/login", { waitUntil: "domcontentloaded" });
  });

  it("provides an actionable error if neither browser is available", async () => {
    mocks.launch.mockRejectedValue(new Error("Executable doesn't exist"));
    await expect(browserLauncher.open("/private/tmp/machun-test-only", "https://example.com", false)).rejects.toMatchObject({ code: "BROWSER_MISSING" });
  });

  it("closes a launched context when portal navigation fails", async () => {
    const fake = context();
    fake.page.goto.mockRejectedValue(new Error("sensitive browser diagnostic"));
    mocks.launch.mockResolvedValue(fake.value);
    await expect(createBrowserLauncher().open("/private/tmp/machun-test-only", "https://example.com", true)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fake.value.close).toHaveBeenCalled();
  });
});
