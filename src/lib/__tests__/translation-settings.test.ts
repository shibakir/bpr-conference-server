import { randomUUID } from "node:crypto";

import { HttpException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TranslationApiService } from "../../translation-api.service";
import TranslationSessionManager, { hashOrganizerKey } from "../translation-session-manager";
import { TRANSLATION_PRESETS, updateTranslationSettingsSchema } from "../translation-settings";

const manager = TranslationSessionManager.getInstance();
const sessions: string[] = [];
function session() {
    const id = randomUUID();
    sessions.push(id);
    manager.createSession(id, "organizer-test", {
        organizerKeyHash: hashOrganizerKey("owner-key"),
        enableAudioTranslation: true,
        enableTranscription: true,
    });
    return { id, api: new TranslationApiService() };
}
function status(action: () => unknown) {
    try {
        action();
    } catch (error) {
        if (error instanceof HttpException) return error.getStatus();
        throw error;
    }
    throw new Error("Expected an HTTP error");
}

describe("Translation settings API", () => {
    afterEach(async () => {
        for (const id of sessions.splice(0)) await manager.removeAllTranslations(id);
    });

    it("requires owner access for reads and writes, validates choices", () => {
        const { id, api } = session();
        expect(status(() => api.getTranslationSettings(id, {}))).toBe(403);
        expect(
            status(() =>
                api.updateTranslationSettings(id, {
                    organizerKey: "wrong",
                    expectedVersion: 1,
                    maxOutputBacklogMs: 2000,
                    inputFrameSizeMs: 50,
                }),
            ),
        ).toBe(403);
        expect(
            updateTranslationSettingsSchema.safeParse({
                organizerKey: "owner-key",
                expectedVersion: 1,
                maxOutputBacklogMs: -1,
                inputFrameSizeMs: 13,
            }).success,
        ).toBe(false);
        expect(manager.getTranslationSettings(id)?.settings.version).toBe(1);
    });

    it("persists defaults and updates, rejects stale edits and reports partial application", () => {
        const { id, api } = session();
        expect(
            api.getTranslationSettings(id, { "x-organizer-key": "owner-key" })?.settings,
        ).toEqual({
            maxOutputBacklogMs: 2000,
            inputFrameSizeMs: 100,
            preset: "balanced",
            version: 1,
        });
        expect(
            api.getTranslationSettings(id, { "x-organizer-key": "owner-key" })
                ?.availableInputFrameSizesMs,
        ).toEqual([50, 100, 200, 300]);
        const body = {
            organizerKey: "owner-key",
            expectedVersion: 1,
            maxOutputBacklogMs: 3000,
            inputFrameSizeMs: 50,
        };
        const updated = api.updateTranslationSettings(id, body);
        expect(updated.settings).toEqual({
            maxOutputBacklogMs: 3000,
            inputFrameSizeMs: 50,
            preset: "manual",
            version: 2,
        });
        expect(status(() => api.updateTranslationSettings(id, body))).toBe(409);
        expect(
            api.getTranslationSettings(id, { "x-organizer-key": "owner-key" })?.settings,
        ).toEqual(updated.settings);
    });

    it.each(Object.entries(TRANSLATION_PRESETS))(
        "persists the %s preset and its values",
        (preset, settings) => {
            const { id, api } = session();
            const updated = api.updateTranslationSettings(id, {
                organizerKey: "owner-key",
                expectedVersion: 1,
                preset,
                ...settings,
            });
            expect(updated.settings).toEqual({
                ...settings,
                preset,
                version: preset === "balanced" ? 1 : 2,
            });
            expect(
                api.getTranslationSettings(id, { "x-organizer-key": "owner-key" })?.settings,
            ).toEqual(updated.settings);
        },
    );

    it("persists manual mode even when its values equal a preset, and detects mode-only conflicts", () => {
        const { id, api } = session();
        const body = {
            organizerKey: "owner-key",
            expectedVersion: 1,
            preset: "manual",
            ...TRANSLATION_PRESETS.balanced,
        };
        const updated = api.updateTranslationSettings(id, body);
        expect(updated.settings).toEqual({
            ...TRANSLATION_PRESETS.balanced,
            preset: "manual",
            version: 2,
        });
        expect(
            status(() => api.updateTranslationSettings(id, { ...body, preset: "balanced" })),
        ).toBe(409);
        expect(
            api.getTranslationSettings(id, { "x-organizer-key": "owner-key" })?.settings.preset,
        ).toBe("manual");
        expect(
            api.updateTranslationSettings(id, { ...body, expectedVersion: 2 }).settings.version,
        ).toBe(2);
    });

    it("rejects mismatched presets and accepts older clients as manual settings", () => {
        const { id, api } = session();
        const body = {
            organizerKey: "owner-key",
            expectedVersion: 1,
            ...TRANSLATION_PRESETS.poorConnection,
        };
        expect(
            status(() => api.updateTranslationSettings(id, { ...body, preset: "quality" })),
        ).toBe(400);
        expect(
            status(() => api.updateTranslationSettings(id, { ...body, preset: "unknown" })),
        ).toBe(400);
        expect(manager.getTranslationSettings(id)?.settings.version).toBe(1);
        expect(api.updateTranslationSettings(id, body).settings).toEqual({
            ...TRANSLATION_PRESETS.poorConnection,
            preset: "manual",
            version: 2,
        });
    });

    it("applies settings to active bridges and exposes failures per language", async () => {
        const { id } = session();
        let applied = { maxOutputBacklogMs: 1000, inputFrameSizeMs: 100, version: 1 };
        const good = {
            status: "active",
            applySettings: vi.fn((settings) => {
                applied = settings;
            }),
            getDiagnostics: () => ({ settings: applied }),
            stop: vi.fn().mockResolvedValue(undefined),
        };
        const bad = {
            status: "active",
            applySettings: vi.fn(() => {
                throw new Error("unavailable");
            }),
            getDiagnostics: () => ({ settings: { version: 1 } }),
            stop: vi.fn().mockResolvedValue(undefined),
        };
        const internals = manager as unknown as { translations: Map<string, Map<string, unknown>> };
        internals.translations.set(
            id,
            new Map<string, unknown>([
                ["cs", good],
                ["de", bad],
            ]),
        );
        const result = manager.updateTranslationSettings(
            id,
            {
                ...TRANSLATION_PRESETS.poorConnection,
            },
            "poorConnection",
        );
        expect(good.applySettings).toHaveBeenCalledOnce();
        expect(good.applySettings).toHaveBeenCalledWith({
            ...TRANSLATION_PRESETS.poorConnection,
            preset: "poorConnection",
            version: 2,
        });
        expect(result.partialFailure).toBe(true);
        expect(result.errors).toEqual([{ language: "de", message: "unavailable" }]);
        expect(result.translations.find((t) => t.language === "cs")?.settings.version).toBe(2);
        expect(result.translations.find((t) => t.language === "de")?.settings.version).toBe(1);
    });
});
