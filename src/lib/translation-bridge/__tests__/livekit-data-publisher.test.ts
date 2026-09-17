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
    it("preserves the pending control when caption overflow follows a stream rotation", async () => {
        const { room, publishData } = createRoom([]);
        const publisher = new TranslationDataPublisher({ targetLanguage: "cs" });
        publisher.publishControl(room, { historyRevision: 0 });
        publisher.resetStream();
        let sending!: Promise<void>;
        for (let i = 0; i < 55; i++)
            sending = publisher.publishTranscription(room, String(i), false, i);
        await sending;
        const payloads = publishData.mock.calls.map(([data]) =>
            JSON.parse(new TextDecoder().decode(data)),
        );
        expect(payloads[0]).toMatchObject({ type: "translation-control" });
        expect(payloads).toHaveLength(50);
        expect(publisher.getDiagnostics().droppedCaptionSegments).toBe(6);
    });
    it("keeps pending controls while rotating captions and leaves historyRevision unchanged", async () => {
        const { room, publishData } = createRoom([]);
        const publisher = new TranslationDataPublisher({
            targetLanguage: "cs",
            historyRevision: 7,
        });
        const sending = publisher.publishTranscription(room, "unsent old", true, 1);
        publisher.publishControl(room, { historyRevision: 7 });
        publisher.resetStream();
        void publisher.publishTranscription(room, "new", true, 2);
        await sending;
        const payloads = publishData.mock.calls.map(([data]) =>
            JSON.parse(new TextDecoder().decode(data)),
        );
        expect(payloads).toHaveLength(2);
        expect(payloads[0]).toMatchObject({
            type: "translation-control",
            control: { historyRevision: 7 },
        });
        expect(payloads[1]).toMatchObject({
            snapshotText: "new",
            historyRevision: 7,
            streamGeneration: 1,
        });
    });
    it("broadcasts history resets to every listener, including hidden caption languages", async () => {
        const { room, publishData } = createRoom([
            { identity: "listener-cs", language: "cs" },
            { identity: "listener-de", language: "de" },
        ]);
        const publisher = new TranslationDataPublisher({ targetLanguage: "cs" });
        publisher.setHistoryRevision(1);
        publisher.resetStream();
        publisher.publishControl(room, { historyRevision: 1 });
        await publisher.waitForIdle(new AbortController().signal);
        await publisher.publishTranscription(room, "new", true, 1);
        const [encoded, options] = getPublishCall(publishData);
        expect(JSON.parse(new TextDecoder().decode(encoded))).toMatchObject({
            type: "translation-control",
            language: "cs",
            control: { historyRevision: 1 },
        });
        expect(options).toEqual({ reliable: true, topic: "translation-control" });
        expect(JSON.parse(new TextDecoder().decode(publishData.mock.calls[1]![0]))).toMatchObject({
            historyRevision: 1,
            snapshotText: "new",
        });
    });

    it("ignores a retired write failure and delivers the replacement stream", async () => {
        const { room, publishData } = createRoom([]);
        let rejectOld!: (reason: Error) => void;
        publishData.mockImplementationOnce(
            () =>
                new Promise((_, reject) => {
                    rejectOld = reject;
                }),
        );
        const onPublicationError = vi.fn();
        const publisher = new TranslationDataPublisher({
            targetLanguage: "cs",
            onPublicationError,
        });
        const sending = publisher.publishTranscription(room, "old", true, 1);
        await Promise.resolve();
        publisher.setHistoryRevision(1);
        publisher.resetStream();
        publisher.publishControl(room, { historyRevision: 1 });
        void publisher.publishTranscription(room, "new", true, 1);
        rejectOld(new Error("retired transport"));
        await sending;
        expect(onPublicationError).not.toHaveBeenCalled();
        expect(publishData).toHaveBeenCalledTimes(3);
        expect(JSON.parse(new TextDecoder().decode(publishData.mock.calls[2]![0]))).toMatchObject({
            historyRevision: 1,
            snapshotText: "new",
        });
    });

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
            protocolVersion: 2,
            segmentId: expect.stringMatching(/^cs-.+-1$/),
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
            protocolVersion: 2,
            segmentId: expect.stringMatching(/^cs-.+-1$/),
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
    it("finalizes an already sent interim with a complete replacement snapshot", async () => {
        const { room, publishData } = createRoom([{ identity: "listener-cs", language: "cs" }]);
        const publisher = new TranslationDataPublisher({ targetLanguage: "cs", streamEpoch: 5 });
        await publisher.publishTranscription(room, "Ahoj", true, 4);
        await publisher.publishTranscription(room, " světe", true, 4);
        await publisher.publishTranscription(room, "", false, 4);
        const payloads = publishData.mock.calls.map(
            ([data]) => JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>,
        );
        expect(payloads[2]).toMatchObject({
            text: "",
            snapshotText: "Ahoj světe",
            revision: 3,
            final: true,
            streamEpoch: 5,
        });
        expect(payloads[0]?.["streamId"]).toBe(payloads[2]?.["streamId"]);
    });

    it("coalesces a slow data channel without accumulating deltas or blocking audio", async () => {
        const { room, publishData } = createRoom([{ identity: "listener-cs", language: "cs" }]);
        let release!: () => void;
        publishData.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const publisher = new TranslationDataPublisher({ targetLanguage: "cs" });
        const first = publisher.publishTranscription(room, "0", true, 1);
        await Promise.resolve();
        for (let i = 1; i <= 100; i++) void publisher.publishTranscription(room, "a", true, 1);
        expect(publishData).toHaveBeenCalledOnce();
        release();
        await first;
        expect(publishData).toHaveBeenCalledTimes(2);
        const last = JSON.parse(new TextDecoder().decode(publishData.mock.calls[1]![0])) as Record<
            string,
            unknown
        >;
        expect(last["snapshotText"]).toBe("0" + "a".repeat(100));
        expect(last["text"]).toBe("a".repeat(100));
    });

    it("splits oversized Unicode segments below the reliable data packet limit", async () => {
        const { room, publishData } = createRoom([]);
        const publisher = new TranslationDataPublisher({ targetLanguage: "cs" });
        await publisher.publishTranscription(room, "🦊".repeat(4000), false, 1);
        const payloads = publishData.mock.calls.map(([data]) => {
            expect(data.length).toBeLessThan(15000);
            return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
        });
        expect(payloads.map((p) => p["snapshotText"]).join("")).toBe("🦊".repeat(4000));
        expect(payloads.every((p) => p["final"] === true)).toBe(true);
    });

    it("gives reset streams new identities and discards pending retired snapshots", async () => {
        const { room, publishData } = createRoom([]);
        const publisher = new TranslationDataPublisher({ targetLanguage: "cs" });
        await publisher.publishTranscription(room, "old", true, 1);
        publisher.resetStream();
        await publisher.publishTranscription(room, "new", true, 1);
        const payloads = publishData.mock.calls.map(
            ([data]) => JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>,
        );
        expect(payloads[0]?.["streamId"]).not.toBe(payloads[1]?.["streamId"]);
        expect(payloads[1]).toMatchObject({ snapshotText: "new", streamGeneration: 1 });
        publisher.stop();
        await publisher.publishTranscription(room, "stopped", false, 1);
        expect(publishData).toHaveBeenCalledTimes(2);
    });
    it("cancels a stalled data-write watchdog immediately when stopped", async () => {
        vi.useFakeTimers();
        try {
            const { room, publishData } = createRoom([]);
            publishData.mockImplementation(() => new Promise(() => {}));
            const publisher = new TranslationDataPublisher({ targetLanguage: "cs" });
            const sending = publisher.publishTranscription(room, "Ahoj", true, 1);
            await Promise.resolve();
            publisher.stop();
            await sending;
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
