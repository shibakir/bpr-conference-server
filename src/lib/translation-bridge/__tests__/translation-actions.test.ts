import { AudioFrame } from "@livekit/rtc-node";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TranslationBridge } from "../index";
import { prepareAudioTempo } from "../audio-tempo";
import { BoundedAudioInput } from "../bounded-audio-input";
import type { GeminiServerMessage } from "../gemini-live-connection";

beforeAll(() => prepareAudioTempo());
afterEach(() => vi.useRealTimers());

function setup() {
    const bridge = new TranslationBridge("test-session", "cs", "organizer-test", {
        geminiApiKey: "test",
        livekitApiKey: "test",
        livekitApiSecret: "test",
        livekitUrl: "ws://test.invalid",
        enableTranscription: true,
        enableAudioTranslation: true,
    });
    bridge.status = "active";
    const internals = bridge as unknown as {
        geminiConnection: { options: { onDiscontinuity: () => void } };
        translatedAudioOutput: { attach: (source: unknown) => void };
        handleGeminiMessage: (message: GeminiServerMessage) => void;
        operationAbort: AbortController | null;
    };
    const discontinuity = internals.geminiConnection.options.onDiscontinuity;
    let dropped = 0;
    const connection = {
        isReady: true,
        isRecovering: false,
        revision: 1,
        sendAudio: vi.fn((_audio: string, _rate: number) => true),
        endAudioInput: vi.fn(() => true),
        getInputDiagnostics: () => ({ droppedInputMs: dropped }),
        recordDroppedInput: (ms: number) => {
            dropped += ms;
        },
        resetFresh: vi.fn(async () => {
            discontinuity();
            connection.revision++;
        }),
        stop: vi.fn(),
    };
    const published: Record<string, unknown>[] = [];
    const room = {
        remoteParticipants: new Map(),
        localParticipant: {
            publishData: vi.fn(async (bytes: Uint8Array) => {
                published.push(JSON.parse(new TextDecoder().decode(bytes)));
            }),
        },
        removeAllListeners: vi.fn(),
        disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const source = {
        captureFrame: vi.fn().mockResolvedValue(undefined),
        queuedDuration: 0,
        clearQueue: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
        waitForPlayout: vi.fn().mockResolvedValue(undefined),
    };
    internals.translatedAudioOutput.attach(source);
    let feed!: (frame: AudioFrame) => void;
    const reader = new BoundedAudioInput(
        {} as never,
        16000,
        (ms) => connection.recordDroppedInput(ms),
        () => ({
            start(controller) {
                feed = controller.enqueue;
            },
            cancel() {},
        }),
    );
    Object.assign(bridge, { geminiConnection: connection, room, organizerAudioReader: reader });
    return {
        bridge,
        internals,
        connection,
        published,
        source,
        reader,
        feed,
        message: (m: GeminiServerMessage) => internals.handleGeminiMessage(m),
    };
}

describe("coordinated translation actions", () => {
    it("reset drops accepted input and interim text and advances the caption history revision", async () => {
        vi.useFakeTimers();
        const t = setup();
        t.feed(new AudioFrame(new Int16Array(320), 16000, 1, 320));
        const delivered = await t.reader.read();
        t.message({ serverContent: { outputTranscription: { text: "Old unfinished" } } });
        await t.bridge.executeAction("reset", 1);
        expect(t.reader.consume(delivered.value!)).toBe(false);
        expect(t.connection.sendAudio).not.toHaveBeenCalled();
        expect(t.source.clearQueue).toHaveBeenCalled();
        t.message({ serverContent: { outputTranscription: { text: "New sentence." } } });
        await vi.advanceTimersByTimeAsync(200);
        expect(t.published.filter((p) => p["type"] === "transcription")).toMatchObject([
            { snapshotText: "New sentence.", historyRevision: 1 },
        ]);
        expect(t.internals.operationAbort).toBeNull();
        await t.bridge.stop();
    });
    it("drains an already delivered frame and the partial packet before the stream-end signal", async () => {
        vi.useFakeTimers();
        const t = setup();
        t.feed(new AudioFrame(new Int16Array(320).fill(900), 16000, 1, 320));
        const delivered = await t.reader.read();
        t.feed(new AudioFrame(new Int16Array(320).fill(800), 16000, 1, 320));
        const running = t.bridge.executeAction("drain", 0);
        expect(
            Buffer.from(t.connection.sendAudio.mock.calls[0]![0] as unknown as string, "base64")
                .length,
        ).toBe(1280);
        expect(t.reader.consume(delivered.value!)).toBe(false);
        expect(t.connection.endAudioInput).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1250);
        expect(t.connection.endAudioInput).toHaveBeenCalledOnce();
        t.message({
            serverContent: {
                outputTranscription: { text: "The end.", finished: true },
                turnComplete: true,
            },
        });
        await vi.advanceTimersByTimeAsync(40);
        await expect(running).resolves.toBe("completed");
        expect(
            t.published.some((p) => p["snapshotText"] === "The end." && p["final"] === true),
        ).toBe(true);
        expect(t.source.waitForPlayout).toHaveBeenCalledOnce();
        expect(t.connection.resetFresh).not.toHaveBeenCalled();
        expect(t.internals.operationAbort).toBeNull();
        await t.bridge.stop();
    });
    it("settled output without a provider marker is unconfirmed and input is reopened", async () => {
        vi.useFakeTimers();
        const t = setup();
        const running = t.bridge.executeAction("drain", 0);
        t.message({ serverContent: { turnComplete: true } });
        await vi.advanceTimersByTimeAsync(1250);
        t.message({ serverContent: { outputTranscription: { text: "A tail" } } });
        await vi.advanceTimersByTimeAsync(5100);
        await expect(running).resolves.toBe("unconfirmed");
        expect(t.internals.operationAbort).toBeNull();
        expect(t.published[0]).toMatchObject({
            snapshotText: "A tail",
            final: false,
            historyRevision: 0,
        });
        await t.bridge.stop();
    });
    it("a connection change during draining is a failure, not a successful flush", async () => {
        vi.useFakeTimers();
        const t = setup();
        const running = t.bridge.executeAction("drain", 0);
        const failed = expect(running).rejects.toMatchObject({ code: "interrupted" });
        await vi.advanceTimersByTimeAsync(1250);
        t.connection.revision++;
        await vi.advanceTimersByTimeAsync(40);
        await failed;
        expect(t.internals.operationAbort).toBeNull();
        await t.bridge.stop();
    });
    it("continuous exact-zero PCM does not block drain, but quiet nonzero audio is retained", async () => {
        vi.useFakeTimers();
        const t = setup();
        const running = t.bridge.executeAction("drain", 0);
        await vi.advanceTimersByTimeAsync(1250);
        const send = (bytes: Buffer) =>
            t.message({
                serverContent: {
                    modelTurn: {
                        parts: [
                            {
                                inlineData: {
                                    data: bytes.toString("base64"),
                                },
                            },
                        ],
                    },
                },
            });
        send(Buffer.from([1, 0]));
        await vi.advanceTimersByTimeAsync(40);
        expect(t.source.captureFrame).toHaveBeenCalledOnce();
        for (let index = 0; index < 20; index++) {
            send(Buffer.alloc(12000));
            await vi.advanceTimersByTimeAsync(250);
        }
        await expect(running).resolves.toBe("unconfirmed");
        expect(t.source.captureFrame).toHaveBeenCalledOnce();
        expect(t.internals.operationAbort).toBeNull();
        await t.bridge.stop();
    });
    it("stop cancels a drain immediately and leaves no operation timers", async () => {
        vi.useFakeTimers();
        const t = setup();
        const running = t.bridge.executeAction("drain", 0);
        const failed = expect(running).rejects.toMatchObject({ code: "stopped" });
        await t.bridge.stop();
        await failed;
        expect(vi.getTimerCount()).toBe(0);
    });
    it("a stalled output is bounded by the operation deadline", async () => {
        vi.useFakeTimers();
        const t = setup();
        t.source.waitForPlayout.mockImplementation(() => new Promise(() => {}));
        const running = t.bridge.executeAction("drain", 0);
        const failed = expect(running).rejects.toMatchObject({ code: "timeout" });
        await vi.advanceTimersByTimeAsync(15_001);
        await failed;
        expect(t.internals.operationAbort).toBeNull();
        await t.bridge.stop();
        expect(vi.getTimerCount()).toBe(0);
    });
});
