import { type ParticipantInfo, RoomServiceClient } from "livekit-server-sdk";
import { describe, expect, it, vi } from "vitest";

import * as env from "../server-env";
import { TranslationBridge } from "../translation-bridge";

import TranslationSessionManager, { hashOrganizerKey } from "../translation-session-manager";

type TranslationSessionManagerInternals = {
    countLanguageSubscribers(
        participants: ParticipantInfo[],
        targetLanguage: string,
        organizerIdentity: string | undefined,
        translatorIdentity: string,
    ): number;
};

function createParticipant(identity: string, attributes?: Record<string, string>): ParticipantInfo {
    return {
        identity,
        ...(attributes ? { attributes } : {}),
    } as unknown as ParticipantInfo;
}

describe("TranslationSessionManager", () => {
    it("counts audio and caption-language listeners as translation subscribers", () => {
        const manager =
            TranslationSessionManager.getInstance() as unknown as TranslationSessionManagerInternals;

        const participants = [
            createParticipant("listener-audio-cs", { language: "cs" }),
            createParticipant("listener-caption-cs", {
                language: "original",
                captionLanguages: "en, cs",
            }),
            createParticipant("listener-en", { language: "en" }),
            createParticipant("organizer-host", {
                language: "cs",
                captionLanguages: "cs",
            }),
            createParticipant("translator-cs", {
                language: "cs",
                captionLanguages: "cs",
            }),
        ];

        expect(
            manager.countLanguageSubscribers(participants, "cs", "organizer-host", "translator-cs"),
        ).toBe(2);
    });

    it("requires the organizer key and explicit takeover for a competing presenter lease", async () => {
        const manager = TranslationSessionManager.getInstance();
        const sessionId = `presenter-${Date.now()}`;
        const organizerKey = "test-organizer-key";

        manager.createSession(sessionId, "organizer-host", {
            enableAudioTranslation: true,
            enableTranscription: true,
            organizerKeyHash: hashOrganizerKey(organizerKey),
        });

        try {
            expect(manager.claimPresenter(sessionId, "wrong-key", "client-a")).toEqual({
                status: "invalid_key",
            });

            const firstClaim = manager.claimPresenter(sessionId, organizerKey, "client-a");
            expect(firstClaim.status).toBe("claimed");
            expect(manager.hasActivePresenterLease(sessionId, organizerKey, "client-a")).toBe(true);

            const competingClaim = manager.claimPresenter(sessionId, organizerKey, "client-b");
            expect(competingClaim.status).toBe("already_active");
            expect(manager.hasActivePresenterLease(sessionId, organizerKey, "client-b")).toBe(
                false,
            );

            const takeoverClaim = manager.claimPresenter(sessionId, organizerKey, "client-b", {
                takeover: true,
            });
            expect(takeoverClaim.status).toBe("claimed");
            expect(manager.hasActivePresenterLease(sessionId, organizerKey, "client-a")).toBe(
                false,
            );
            expect(manager.hasActivePresenterLease(sessionId, organizerKey, "client-b")).toBe(true);
        } finally {
            await manager.removeAllTranslations(sessionId);
        }
    });
    it("shares a starting bridge and applies settings changed during startup to it and later languages", async () => {
        const manager = TranslationSessionManager.getInstance();
        const id = `startup-${Date.now()}`;
        vi.spyOn(env, "getGeminiApiKey").mockReturnValue("test");
        vi.spyOn(env, "getLiveKitCredentials").mockReturnValue({
            apiKey: "test",
            apiSecret: "test",
        });
        vi.spyOn(env, "getLiveKitUrl").mockReturnValue("ws://test.invalid");
        vi.spyOn(RoomServiceClient.prototype, "deleteRoom").mockResolvedValue(undefined);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const start = vi
            .spyOn(TranslationBridge.prototype, "start")
            .mockImplementation(async function (this: TranslationBridge) {
                await gate;
                this.status = "active";
            });
        manager.createSession(id, "organizer-test", {
            enableAudioTranslation: true,
            enableTranscription: true,
            organizerKeyHash: hashOrganizerKey("test"),
        });
        try {
            const first = manager.getOrCreate(id, "cs", "organizer-test");
            const duplicate = manager.getOrCreate(id, "cs", "organizer-test");
            expect(start).toHaveBeenCalledOnce();
            manager.updateTranslationSettings(id, {
                maxOutputBacklogMs: 3000,
                inputFrameSizeMs: 200,
            });
            release();
            const [a, b] = await Promise.all([first, duplicate]);
            expect(a).toBe(b);
            expect(a.getDiagnostics().settings).toEqual({
                maxOutputBacklogMs: 3000,
                inputFrameSizeMs: 200,
                preset: "manual",
                version: 2,
            });
            const later = await manager.getOrCreate(id, "de", "organizer-test");
            expect(later.getDiagnostics().settings).toEqual(a.getDiagnostics().settings);
            expect(start).toHaveBeenCalledTimes(2);
            a.status = "error";
            const [replacement, duplicateReplacement] = await Promise.all([
                manager.getOrCreate(id, "cs", "organizer-test"),
                manager.getOrCreate(id, "cs", "organizer-test"),
            ]);
            expect(replacement).not.toBe(a);
            expect(duplicateReplacement).toBe(replacement);
            expect(start).toHaveBeenCalledTimes(3);
        } finally {
            await manager.removeAllTranslations(id);
            vi.restoreAllMocks();
        }
    });
});
