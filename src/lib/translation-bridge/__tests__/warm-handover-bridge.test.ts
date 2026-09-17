import { AudioFrame, type AudioSource } from "@livekit/rtc-node";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@livekit/rtc-node";
import { prepareAudioTempo } from "../audio-tempo";
import { TranslationBridge } from "../index";
import { GeminiSessionCoordinator } from "../gemini-session-coordinator";
import { GeminiLiveConnection } from "../gemini-live-connection";
import { TranslatedAudioOutput } from "../translated-audio-output";
import { socketFactory } from "./fake-gemini-socket";

type Caption = {
    type: string;
    snapshotText: string;
    streamId: string;
    streamGeneration: number;
    historyRevision: number;
    segmentId: string;
};
const bridges: TranslationBridge[] = [];
beforeAll(() => prepareAudioTempo());
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
});

async function setup(enabled = true, transcription = true) {
    const factory = socketFactory();
    const bridge = new TranslationBridge("session", "cs", "organizer", {
        geminiApiKey: "test",
        livekitUrl: "ws://unused",
        livekitApiKey: "test",
        livekitApiSecret: "test",
        enableTranscription: transcription,
        enableAudioTranslation: true,
        warmHandoverEnabled: enabled,
        geminiWebSocketFactory: factory.factory,
        historyRevision: 7,
        streamEpoch: 3,
    });
    bridges.push(bridge);
    bridge.status = "active";
    const internals = bridge as unknown as {
        room: Room;
        geminiConnection: GeminiSessionCoordinator | GeminiLiveConnection;
        translatedAudioOutput: TranslatedAudioOutput;
        sendAudioToGemini(frame: AudioFrame): void;
    };
    const published: Caption[] = [];
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
    internals.room = room as unknown as Room;
    const source = {
        captureFrame: vi.fn().mockResolvedValue(undefined),
        clearQueue: vi.fn(),
        queuedDuration: 0,
        close: vi.fn().mockResolvedValue(undefined),
        waitForPlayout: vi.fn().mockResolvedValue(undefined),
    };
    internals.translatedAudioOutput.attach(source as unknown as AudioSource);
    const starting = internals.geminiConnection.connect();
    const a = factory.sockets[0]!;
    a.setup();
    await starting;
    const send = () =>
        internals.sendAudioToGemini(new AudioFrame(new Int16Array(4800), 16000, 1, 4800));
    return { bridge, internals, source, room, published, a, send, ...factory };
}

describe("bridge warm handover", () => {
    it("keeps delivered history, discards pending A text and publishes only future B output on the same room/source", async () => {
        const t = await setup();
        t.a.text("Visible A");
        await vi.advanceTimersByTimeAsync(150);
        const old = t.published[0]!;
        await vi.advanceTimersByTimeAsync(480_000 - 150);
        const b = t.sockets[1]!;
        b.setup();
        t.send();
        const audio = {
            serverContent: {
                modelTurn: {
                    parts: [{ inlineData: { data: Buffer.alloc(960).toString("base64") } }],
                },
            },
        };
        b.receive(audio);
        b.text("discarded standby output");
        expect(t.source.captureFrame).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000);
        t.a.text("not yet sent A");
        b.text("New B");
        t.a.text("late A");
        await vi.advanceTimersByTimeAsync(150);
        expect(t.published.map((p) => p.snapshotText)).toEqual(["Visible A", "New B"]);
        expect(t.published[1]).toMatchObject({
            historyRevision: 7,
            streamGeneration: old.streamGeneration + 1,
        });
        expect(t.published[1]!.streamId).not.toBe(old.streamId);
        expect(t.published[1]!.segmentId).not.toBe(old.segmentId);
        expect(t.internals.room).toBe(t.room);
        expect(t.source.close).not.toHaveBeenCalled();
        b.receive(audio);
        t.a.receive(audio);
        await vi.advanceTimersByTimeAsync(0);
        expect(t.source.captureFrame).toHaveBeenCalledOnce();
        expect(t.room.disconnect).not.toHaveBeenCalled();
    });

    it("publishes B captions while clearing an in-flight A capture; bounds B's audio queue", async () => {
        const t = await setup();
        let rejectOld!: (error: Error) => void;
        t.source.captureFrame.mockImplementationOnce(
            () =>
                new Promise((_, reject) => {
                    rejectOld = reject;
                }),
        );
        await vi.advanceTimersByTimeAsync(480_000);
        const b = t.sockets[1]!;
        b.setup();
        t.send();
        await vi.advanceTimersByTimeAsync(30_000);
        t.a.receive({
            serverContent: {
                modelTurn: {
                    parts: [{ inlineData: { data: Buffer.alloc(960).toString("base64") } }],
                },
            },
        });
        b.text("Immediately visible.");
        b.receive({
            serverContent: {
                modelTurn: {
                    parts: [{ inlineData: { data: Buffer.alloc(48000 * 3).toString("base64") } }],
                },
            },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(t.published.map((p) => p.snapshotText)).toEqual(["Immediately visible."]);
        expect(t.source.captureFrame).toHaveBeenCalledOnce();
        expect(t.source.clearQueue).not.toHaveBeenCalled();
        expect(t.internals.translatedAudioOutput.getTotalBacklogMs()).toBeLessThanOrEqual(
            t.bridge.getDiagnostics().settings.maxOutputBacklogMs,
        );
        rejectOld(new Error("old capture failed"));
        await vi.advanceTimersByTimeAsync(0);
        expect(t.source.clearQueue).toHaveBeenCalledOnce();
        expect(t.source.captureFrame.mock.calls.length).toBeGreaterThan(1);
        expect(t.bridge.status).toBe("active");
        expect(t.source.close).not.toHaveBeenCalled();
    });

    it("manual reset cancels warmup and changes history only through the reset contract", async () => {
        const t = await setup();
        await vi.advanceTimersByTimeAsync(480_000);
        const b = t.sockets[1]!;
        b.setup();
        t.send();
        const reset = t.bridge.executeAction("reset", 8);
        await vi.advanceTimersByTimeAsync(0);
        t.sockets[2]!.setup();
        await vi.advanceTimersByTimeAsync(40);
        await expect(reset).resolves.toBe("completed");
        b.text("cancelled");
        t.sockets[2]!.text("fresh.");
        await vi.advanceTimersByTimeAsync(0);
        expect(t.published.map((p) => p.snapshotText)).toEqual(["fresh."]);
        expect(t.published[0]!.historyRevision).toBe(8);
    });

    it("interrupts drain when active fails instead of completing it on another session", async () => {
        const t = await setup();
        await vi.advanceTimersByTimeAsync(480_000);
        const b = t.sockets[1]!;
        b.setup();
        t.send();
        b.text("ready standby");
        const drain = t.bridge.executeAction("drain", 7);
        const failed = expect(drain).rejects.toMatchObject({ code: "interrupted" });
        await vi.advanceTimersByTimeAsync(1250);
        t.a.finishClose();
        await vi.advanceTimersByTimeAsync(40);
        await failed;
        expect(b.terminate).toHaveBeenCalled();
        expect(t.published).toHaveLength(0);
    });

    it("blocks both old streams immediately on reset even while their sockets are still closing", async () => {
        const t = await setup();
        await vi.advanceTimersByTimeAsync(480_000);
        const b = t.sockets[1]!;
        b.setup();
        t.send();
        b.delayedClose = true;
        t.a.delayedClose = true;
        const reset = t.bridge.executeAction("reset", 8);
        t.a.text("must not appear in reset history.");
        b.text("nor standby output.");
        await vi.advanceTimersByTimeAsync(900);
        expect(t.published).toHaveLength(0);
        expect(t.sockets).toHaveLength(2);
        b.finishClose();
        t.a.finishClose();
        await vi.advanceTimersByTimeAsync(0);
        t.sockets[2]!.setup();
        await vi.advanceTimersByTimeAsync(40);
        await reset;
        t.sockets[2]!.text("new reset context.");
        await vi.advanceTimersByTimeAsync(0);
        expect(t.published.map((p) => p.snapshotText)).toEqual(["new reset context."]);
        expect(t.published[0]!.historyRevision).toBe(8);
        expect(t.maxOpen()).toBe(2);
    });

    it.each([
        [false, true],
        [true, false],
    ])("keeps legacy transport for enabled=%s transcription=%s", async (enabled, transcription) => {
        const t = await setup(enabled, transcription);
        expect(t.internals.geminiConnection).toBeInstanceOf(GeminiLiveConnection);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(t.sockets).toHaveLength(1);
        t.a.receive({ goAway: { timeLeft: "60s" } });
        expect(t.sockets).toHaveLength(2);
    });
});
