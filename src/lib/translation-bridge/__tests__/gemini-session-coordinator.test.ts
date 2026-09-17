import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    GeminiSessionCoordinator,
    parseGoAwayDuration,
    WARM_HANDOVER_DEFAULTS,
} from "../gemini-session-coordinator";
import { socketFactory } from "./fake-gemini-socket";

const frame = Buffer.alloc(3200).toString("base64");
const running: GeminiSessionCoordinator[] = [];

async function setup(timings: Partial<typeof WARM_HANDOVER_DEFAULTS> = {}, language = "cs") {
    const factory = socketFactory();
    const onMessage = vi.fn();
    const onHandover = vi.fn(() => ({ discardedPendingCaptionChars: 3 }));
    const onDiscontinuity = vi.fn();
    const coordinator = new GeminiSessionCoordinator({
        apiKey: "test-key",
        model: "test-model",
        sessionId: "session",
        targetLanguage: language,
        enableAudioTranslation: true,
        enableTranscription: true,
        contextCompressionTriggerTokens: 25_000,
        contextCompressionTargetTokens: 8000,
        shouldReconnect: () => true,
        webSocketFactory: factory.factory,
        onMessage,
        onHandover,
        onDiscontinuity,
        timings,
    });
    running.push(coordinator);
    const start = coordinator.connect();
    const a = factory.sockets[0]!;
    a.setup();
    await start;
    const candidate = async () => {
        await vi.advanceTimersByTimeAsync(
            timings.standbyStartAgeMs ?? WARM_HANDOVER_DEFAULTS.standbyStartAgeMs,
        );
        const b = factory.sockets.at(-1)!;
        expect(b).not.toBe(a);
        b.setup();
        await Promise.resolve();
        coordinator.sendAudio(frame, 16000);
        return b;
    };
    return { coordinator, a, candidate, onMessage, onHandover, onDiscontinuity, ...factory };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
    for (const coordinator of running.splice(0)) coordinator.stop();
    await vi.advanceTimersByTimeAsync(1001);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
});

describe("warm Gemini handover", () => {
    it("fans out identical live packets and switches exactly once on new text after 30 seconds", async () => {
        const t = await setup();
        t.a.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "secret-A" } });
        t.coordinator.sendAudio(frame, 16000);
        const historical = t.a.audioPackets().length;
        const b = await t.candidate();
        expect(JSON.parse(b.sent[0]!).setup.sessionResumption).toEqual({});
        expect(b.audioPackets()).toEqual(t.a.audioPackets().slice(historical));
        const lateMessage = t.a.listeners("message")[0]!;
        const lateClose = t.a.listeners("close")[0]!;
        b.text("discarded");
        b.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } } });
        t.onMessage.mockClear();
        await vi.advanceTimersByTimeAsync(29_999);
        b.text("also discarded");
        expect(t.onMessage).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        for (const message of [
            { inputTranscription: { text: "source" } },
            { usageMetadata: {} },
            { serverContent: { outputTranscription: { text: "  " } } },
            { serverContent: { turnComplete: true } },
        ])
            b.receive(message);
        expect(t.onHandover).not.toHaveBeenCalled();
        t.a.text("last A");
        t.onMessage.mockClear();
        b.text("first B");
        expect(t.onHandover).toHaveBeenCalledOnce();
        expect(t.onMessage).toHaveBeenCalledExactlyOnceWith({
            serverContent: { outputTranscription: { text: "first B" } },
        });
        lateMessage(Buffer.from(JSON.stringify({ outputTranscription: { text: "late A" } })));
        lateClose(1006, Buffer.alloc(0));
        t.a.callbacks[0]?.(new Error("late send"));
        t.a.emit("error", new Error("late error"));
        expect(t.onMessage).toHaveBeenCalledOnce();
        const packetsA = t.a.audioPackets().length;
        t.coordinator.sendAudio(frame, 16000);
        expect(t.a.audioPackets()).toHaveLength(packetsA);
        expect(t.coordinator.isRecovering).toBe(false);
        expect(t.maxOpen()).toBe(2);
        expect(t.onDiscontinuity).not.toHaveBeenCalled();
    });

    it("starts warmup on first audio, and retains B's socket age for the next rotation", async () => {
        const t = await setup();
        await vi.advanceTimersByTimeAsync(480_000);
        const b = t.sockets[1]!;
        t.coordinator.sendAudio(frame, 16000);
        expect(b.sent).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(5000);
        b.setup();
        await vi.advanceTimersByTimeAsync(5000);
        t.coordinator.sendAudio(frame, 16000);
        await vi.advanceTimersByTimeAsync(29_999);
        b.text("early");
        expect(t.onHandover).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        b.receive({ serverContent: { modelTurn: { parts: [{ text: "fallback text" }] } } });
        expect(t.onHandover).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(444_999);
        expect(t.sockets).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(t.sockets).toHaveLength(3); // setup B + 480 seconds, not promotion + 480
        expect(t.maxOpen()).toBe(2);
    });

    it("cancels a congested standby without counting its drops against active or resetting A", async () => {
        const t = await setup();
        t.coordinator.recordDroppedInput(75);
        const b = await t.candidate();
        b.bufferedAmount = 100_000;
        expect(t.coordinator.sendAudio(frame, 16000)).toBe(true);
        expect(b.terminate).toHaveBeenCalled();
        expect(t.coordinator.getInputDiagnostics().droppedInputMs).toBe(75);
        expect(t.coordinator.isRecovering).toBe(false);
        expect(t.onDiscontinuity).not.toHaveBeenCalled();
        t.a.text("still translating");
        await vi.advanceTimersByTimeAsync(59_999);
        expect(t.sockets).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(t.sockets).toHaveLength(3);
    });

    it("times out setup, keeps A working and suppresses retries until speech resumes", async () => {
        const t = await setup();
        await vi.advanceTimersByTimeAsync(480_000 + 15_000);
        expect(t.sockets[1]!.terminate).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(t.sockets).toHaveLength(2);
        t.a.text("resume");
        await vi.advanceTimersByTimeAsync(0);
        expect(t.sockets).toHaveLength(3);
        expect(t.coordinator.isReady).toBe(true);
    });

    it("discards a silent candidate at its lifetime limit and never switches using old text", async () => {
        const t = await setup();
        const b = await t.candidate();
        b.text("too early");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(b.terminate).toHaveBeenCalled();
        expect(t.onHandover).not.toHaveBeenCalled();
        expect(t.onMessage).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(t.sockets).toHaveLength(2);
    });

    it("handles repeated GoAway, the earliest deadline and emergency promotion without replay", async () => {
        const t = await setup();
        t.a.receive({ goAway: { timeLeft: "60s" } });
        t.a.receive({ goAway: { timeLeft: "90s" } });
        t.a.receive({ goAway: { timeLeft: "20s" } });
        expect(t.sockets).toHaveLength(2);
        const b = t.sockets[1]!;
        b.setup();
        t.coordinator.sendAudio(frame, 16000);
        await vi.advanceTimersByTimeAsync(14_000);
        b.text("discarded but proves readiness");
        t.onMessage.mockClear();
        await vi.advanceTimersByTimeAsync(1000);
        expect(t.onHandover).toHaveBeenCalledOnce();
        expect(t.onMessage).not.toHaveBeenCalled();
        b.text("future text");
        expect(t.onMessage).toHaveBeenCalledOnce();
        expect(t.maxOpen()).toBe(2);
    });

    it.each(["invalid", "1s"])(
        "falls back for %s deadlines without opening a third socket",
        async (duration) => {
            const t = await setup();
            t.a.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-A" } });
            const b = await t.candidate();
            b.delayedClose = true;
            t.a.receive({ goAway: { timeLeft: duration } });
            expect(t.coordinator.isRecovering).toBe(true);
            await vi.advanceTimersByTimeAsync(900);
            expect(t.sockets).toHaveLength(2);
            b.finishClose();
            await vi.advanceTimersByTimeAsync(0);
            const recovered = t.sockets[2]!;
            recovered.setup();
            await Promise.resolve();
            expect(JSON.parse(recovered.sent[0]!).setup.sessionResumption).toEqual({
                handle: "resume-A",
            });
            expect(t.coordinator.isRecovering).toBe(false);
            expect(t.onHandover).not.toHaveBeenCalled();
            expect(t.maxOpen()).toBe(2);
        },
    );

    it.each([1000, 2001])(
        "uses freshness, not setup alone, on active failure (age %s)",
        async (age) => {
            const t = await setup();
            const b = await t.candidate();
            b.text("early B");
            await vi.advanceTimersByTimeAsync(age);
            t.a.finishClose();
            expect(t.onHandover).toHaveBeenCalledTimes(age <= 2000 ? 1 : 0);
            expect(t.onMessage).not.toHaveBeenCalled();
            if (age <= 2000) {
                b.text("new B");
                expect(t.onMessage).toHaveBeenCalledOnce();
            } else expect(t.coordinator.isRecovering).toBe(true);
        },
    );

    it("rejects standby GoAway and cancels its transport's own recovery", async () => {
        const t = await setup();
        const b = await t.candidate();
        b.receive({ goAway: { timeLeft: "60s" } });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(t.sockets).toHaveLength(2);
        expect(t.coordinator.isRecovering).toBe(false);
        expect(t.onDiscontinuity).not.toHaveBeenCalled();
    });

    it("cancels standby on drain, restarts preparation afterwards, and resets fresh", async () => {
        const t = await setup();
        const b = await t.candidate();
        const lateSetup = b.listeners("message")[0]!;
        t.coordinator.pauseHandover();
        b.text("ignored");
        await vi.advanceTimersByTimeAsync(40_000);
        expect(t.sockets).toHaveLength(2);
        t.coordinator.resumeHandover();
        await vi.advanceTimersByTimeAsync(0);
        expect(t.sockets).toHaveLength(3);
        const reset = t.coordinator.resetFresh();
        await vi.advanceTimersByTimeAsync(0);
        const fresh = t.sockets[3]!;
        fresh.setup();
        await reset;
        lateSetup(Buffer.from(JSON.stringify({ setupComplete: {} })));
        expect(t.onMessage).not.toHaveBeenCalled();
        expect(t.onDiscontinuity).toHaveBeenCalledOnce();
        expect(JSON.parse(fresh.sent[0]!).setup.sessionResumption).toEqual({});
        expect(t.maxOpen()).toBe(2);
    });

    it("never promotes during drain; forced recovery changes the revision", async () => {
        const t = await setup();
        const b = await t.candidate();
        b.text("ready");
        const revision = t.coordinator.revision;
        t.coordinator.pauseHandover();
        t.a.finishClose();
        expect(t.coordinator.revision).toBeGreaterThan(revision);
        expect(t.onHandover).not.toHaveBeenCalled();
        expect(t.coordinator.isRecovering).toBe(true);
    });

    it("stop cancels an in-flight setup and every future retry", async () => {
        const t = await setup();
        await vi.advanceTimersByTimeAsync(480_000);
        const b = t.sockets[1]!;
        const lateMessage = b.listeners("message")[0]!;
        t.coordinator.stop();
        lateMessage(Buffer.from(JSON.stringify({ setupComplete: {} })));
        await vi.advanceTimersByTimeAsync(1_000_000);
        expect(t.sockets).toHaveLength(2);
        expect(t.onHandover).not.toHaveBeenCalled();
        expect(t.coordinator.isReady).toBe(false);
    });

    it("bounds repeated recovery failures and cancels the backoff when stopped", async () => {
        const t = await setup();
        t.a.finishClose();
        await vi.advanceTimersByTimeAsync(600);
        const second = t.sockets[1]!;
        second.finishClose();
        await vi.advanceTimersByTimeAsync(999);
        expect(t.sockets).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(202);
        const third = t.sockets[2]!;
        third.finishClose();
        await vi.advanceTimersByTimeAsync(1999);
        expect(t.sockets).toHaveLength(3);
        t.coordinator.stop();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(t.sockets).toHaveLength(3);
    });

    it("recovers a failed manual reset and permits future warmup", async () => {
        const t = await setup({ standbyStartAgeMs: 1000 });
        const reset = t.coordinator.resetFresh();
        const failed = expect(reset).rejects.toThrow("closed before setup");
        await vi.advanceTimersByTimeAsync(0);
        t.sockets[1]!.finishClose();
        await failed;
        await vi.advanceTimersByTimeAsync(600);
        t.sockets[2]!.setup();
        await vi.advanceTimersByTimeAsync(1000);
        expect(t.sockets).toHaveLength(4);
        expect(t.coordinator.isRecovering).toBe(false);
    });

    it("keeps loss counters across promotions and isolates different languages", async () => {
        const cs = await setup({ standbyStartAgeMs: 1000 });
        const en = await setup({ standbyStartAgeMs: 1_000_000 }, "en");
        cs.coordinator.recordDroppedInput(125);
        const b = await cs.candidate();
        await vi.advanceTimersByTimeAsync(30_000);
        b.text("nový text");
        cs.coordinator.recordDroppedInput(75);
        expect(cs.coordinator.getInputDiagnostics().droppedInputMs).toBe(200);
        expect(en.sockets).toHaveLength(1);
        expect(en.onMessage).not.toHaveBeenCalled();
        expect(en.coordinator.getInputDiagnostics().droppedInputMs).toBe(0);
    });
});

describe("GoAway duration", () => {
    it("parses protobuf durations and rejects invalid or unbounded values", () => {
        expect(parseGoAwayDuration("1.123456789s")).toBeCloseTo(1123.456789);
        expect(parseGoAwayDuration("0s")).toBe(0);
        for (const value of [
            undefined,
            "",
            "-1s",
            "NaNs",
            "Infinitys",
            "2ms",
            "1",
            "1.1234567890s",
            "999999999999s",
        ])
            expect(parseGoAwayDuration(value)).toBeNull();
    });
});
