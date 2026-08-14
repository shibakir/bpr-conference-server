import { type ParticipantInfo } from "livekit-server-sdk";
import { describe, expect, it } from "vitest";

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
});
