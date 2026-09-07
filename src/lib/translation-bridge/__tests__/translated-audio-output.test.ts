import { prepareAudioTempo } from "../audio-tempo";
import type { AudioFrame, AudioSource } from "@livekit/rtc-node";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TranslatedAudioOutput } from "../translated-audio-output";

function setup(capture: (frame: AudioFrame) => Promise<void>) {
    const source = {
        captureFrame: vi.fn(capture),
        queuedDuration: 0,
        clearQueue: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
    };
    const output = new TranslatedAudioOutput({
        targetLanguage: "cs",
        sampleRate: 24000,
        channels: 1,
        maxBacklogMs: 1000,
        targetBacklogMs: 500,
        backlogLogIntervalMs: 5000,
        backlogInfoThresholdMs: 500,
        isClosed: () => false,
        onFramePublished: vi.fn(),
    });
    output.attach(source as unknown as AudioSource);
    return { output, source };
}

describe("TranslatedAudioOutput", () => {
    it("caps one huge response even while native capture is blocked", async () => {
        let release!: () => void;
        const { output, source } = setup(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        output.enqueue(Buffer.alloc(960).toString("base64"), 0, 1);
        output.enqueue(Buffer.alloc(24_000 * 2 * 60).toString("base64"), 0, 2);
        expect(source.captureFrame).toHaveBeenCalledTimes(1);
        expect(output.getTotalBacklogMs()).toBeLessThanOrEqual(1000);
        expect(output.getDiagnostics().droppedOutputMs).toBeGreaterThan(59_000);
        await output.close();
        release();
        await Promise.resolve();
        expect(source.captureFrame).toHaveBeenCalledTimes(1);
        expect(source.close).toHaveBeenCalledOnce();
    });

    it("applies a lower limit immediately without clearing a capture in progress", async () => {
        let release!: () => void;
        const { output, source } = setup(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        output.setMaxBacklogMs(5000);
        output.enqueue(Buffer.alloc(48_000 * 4).toString("base64"), 0, 1);
        output.setMaxBacklogMs(1000);
        expect(output.getTotalBacklogMs()).toBeLessThanOrEqual(500);
        output.clear();
        expect(source.clearQueue).not.toHaveBeenCalled();
        release();
        await new Promise((resolve) => setImmediate(resolve));
        expect(source.clearQueue).toHaveBeenCalledOnce();
        expect(output.getTotalBacklogMs()).toBe(0);
        await output.close();
    });
    it("cancels the capture watchdog immediately on stop even if native capture never resolves", async () => {
        vi.useFakeTimers();
        try {
            const { output } = setup(() => new Promise(() => {}));
            output.enqueue(Buffer.alloc(960).toString("base64"), 0, 1);
            await output.close();
            await vi.advanceTimersByTimeAsync(0);
            expect(vi.getTimerCount()).toBe(0);
            expect(output.getTotalBacklogMs()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("closes a stalled capture without starting a competing publisher", async () => {
        vi.useFakeTimers();
        try {
            const { output, source } = setup(() => new Promise(() => {}));
            output.enqueue(Buffer.alloc(48_000).toString("base64"), 0, 1);
            await vi.advanceTimersByTimeAsync(2001);
            expect(source.captureFrame).toHaveBeenCalledOnce();
            expect(source.close).toHaveBeenCalledOnce();
            output.enqueue(Buffer.alloc(48_000).toString("base64"), 0, 2);
            expect(source.captureFrame).toHaveBeenCalledOnce();
            expect(output.getTotalBacklogMs()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("accelerates a sustained backlog smoothly and returns to normal after draining", async () => {
        vi.useFakeTimers();
        try {
            const { output } = setup(
                (frame) =>
                    new Promise((resolve) => setTimeout(resolve, frame.samplesPerChannel / 24)),
            );
            // Keep the queue between the soft and hard limits for two seconds.
            output.enqueue(Buffer.alloc(48_000 * 0.9).toString("base64"), 0, 1);
            for (let i = 0; i < 100; i++) {
                await vi.advanceTimersByTimeAsync(20);
                output.enqueue(Buffer.alloc(960).toString("base64"), 0, i + 2);
                expect(output.getDiagnostics().playbackSpeed).toBeLessThanOrEqual(1.15);
                expect(output.getTotalBacklogMs()).toBeLessThanOrEqual(1000);
            }
            expect(output.getDiagnostics().playbackSpeed).toBeGreaterThan(1);
            expect(output.getDiagnostics().droppedOutputMs).toBe(0);
            await vi.advanceTimersByTimeAsync(3000);
            // Future small packets let the controller finish returning to normal.
            for (let i = 0; i < 20; i++) {
                output.enqueue(Buffer.alloc(960).toString("base64"), 0, i + 102);
                await vi.advanceTimersByTimeAsync(100);
            }
            expect(output.getDiagnostics().playbackSpeed).toBe(1);
            expect(output.getTotalBacklogMs()).toBe(0);
            await output.close();
        } finally {
            vi.useRealTimers();
        }
    });
});

beforeAll(() => prepareAudioTempo());
