import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe("warm handover environment flag", () => {
    it.each([
        [undefined, true],
        ["", true],
        ["false", false],
        ["true", true],
    ])("parses %s as %s", async (value, enabled) => {
        vi.resetModules();
        vi.stubEnv("GEMINI_WARM_HANDOVER_ENABLED", value);
        const { serverEnv } = await import("../server.js");
        expect(serverEnv.GEMINI_WARM_HANDOVER_ENABLED).toBe(enabled);
    });
    it("rejects misspelled values instead of coercing a nonempty string to true", async () => {
        vi.stubEnv("GEMINI_WARM_HANDOVER_ENABLED", "fales");
        await expect(import("../server.js")).rejects.toThrow("GEMINI_WARM_HANDOVER_ENABLED");
    });
});
