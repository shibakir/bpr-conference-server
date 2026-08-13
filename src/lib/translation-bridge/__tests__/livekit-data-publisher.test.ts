import type { Room } from "@livekit/rtc-node";
import { describe, expect, it, vi } from "vitest";

import { parseJson } from "../../api-request";
import { TranslationDataPublisher } from "../livekit-data-publisher";

type PublishData = (payload: Uint8Array, options?: Record<string, unknown>) => Promise<void>;

function createRoom(
    participants: Array<{
        captionLanguages?: string;
        identity: string;
        language?: string;
    }>,
) {
    const publishData = vi.fn<PublishData>().mockResolvedValue(undefined);
    const room = {
        localParticipant: { publishData },
        remoteParticipants: new Map(
            participants.map((participant) => [
                participant.identity,
                {
                    identity: participant.identity,
                    attributes: {
                        ...(participant.language ? { language: participant.language } : {}),
                        ...(participant.captionLanguages
                            ? { captionLanguages: participant.captionLanguages }
                            : {}),
                    },
                },
            ]),
        ),
    } as unknown as Room;

    return { room, publishData };
}

function getPublishCall(publishData: ReturnType<typeof createRoom>["publishData"]) {
    const call = publishData.mock.calls[0];
    if (!call) {
        throw new Error("Expected publishData to be called");
    }

    return call;
}

describe("TranslationDataPublisher", () => {
    it("sends a final transcription only to listeners of the target language", async () => {
        const { room, publishData } = createRoom([
            { identity: "listener-cs", language: "cs" },
            { identity: "listener-en", language: "en" },
        ]);
        const publisher = new TranslationDataPublisher({
            targetLanguage: "cs",
        });

        await publisher.publishTranscription(room, "Ahoj", false, 4);

        const [encodedPayload, options] = getPublishCall(publishData);
        expect(parseJson(new TextDecoder().decode(encodedPayload))).toMatchObject({
            type: "transcription",
            language: "cs",
            segmentId: "cs-4",
            text: "Ahoj",
            final: true,
        });
        expect(options).toEqual({
            reliable: true,
            topic: "transcription",
            destination_identities: ["listener-cs"],
        });
    });

    it("sends transcription to listeners whose floating caption panels include the target language", async () => {
        const { room, publishData } = createRoom([
            { identity: "listener-audio-en", language: "en" },
            {
                identity: "listener-floating-cs",
                language: "en",
                captionLanguages: "cs,ru",
            },
        ]);
        const publisher = new TranslationDataPublisher({
            targetLanguage: "cs",
        });

        await publisher.publishTranscription(room, "Ahoj", false, 4);

        const [, options] = getPublishCall(publishData);
        expect(options).toEqual({
            reliable: true,
            topic: "transcription",
            destination_identities: ["listener-floating-cs"],
        });
    });

    it("sends interim transcription reliably because Gemini may not emit final markers", async () => {
        const { room, publishData } = createRoom([{ identity: "listener-cs", language: "cs" }]);
        const publisher = new TranslationDataPublisher({
            targetLanguage: "cs",
        });

        await publisher.publishTranscription(room, " průběžný text", true, 4);

        const [encodedPayload, options] = getPublishCall(publishData);
        expect(parseJson(new TextDecoder().decode(encodedPayload))).toMatchObject({
            type: "transcription",
            language: "cs",
            segmentId: "cs-4",
            text: " průběžný text",
            final: false,
        });
        expect(options).toEqual({
            reliable: true,
            topic: "transcription",
            destination_identities: ["listener-cs"],
        });
    });

    it("broadcasts transcription when listener language attributes have not synced yet", async () => {
        const { room, publishData } = createRoom([{ identity: "listener-pending" }]);
        const publisher = new TranslationDataPublisher({
            targetLanguage: "cs",
        });

        await publisher.publishTranscription(room, "Ahoj", true, 4);

        const [, options] = getPublishCall(publishData);
        expect(options).toEqual({
            reliable: true,
            topic: "transcription",
        });
    });
});
