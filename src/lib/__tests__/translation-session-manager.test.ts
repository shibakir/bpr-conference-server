import { type ParticipantInfo } from "livekit-server-sdk";
import { describe, expect, it } from "vitest";

import TranslationSessionManager from "../translation-session-manager";

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
});
