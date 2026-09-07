import type { AudioFrame, AudioSource } from "@livekit/rtc-node";
import { describe, expect, it, vi } from "vitest";

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
});
