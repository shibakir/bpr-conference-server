import { AudioFrame, type RemoteAudioTrack } from "@livekit/rtc-node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoundedAudioInput } from "../bounded-audio-input";

function setup() {
    let controller!: { enqueue(frame: AudioFrame): void; close(): void };
    const source = {
        start: (value: typeof controller) => {
            controller = value;
        },
        cancel: vi.fn(() => controller.close()),
    };
    const drop = vi.fn();
    const reader = new BoundedAudioInput({} as RemoteAudioTrack, 16000, drop, () => source);
    return {
        reader,
        drop,
        source,
        frame: (value: number) =>
            controller.enqueue(new AudioFrame(new Int16Array(320).fill(value), 16000, 1, 320)),
    };
}

describe("bounded native audio input", () => {
    afterEach(() => vi.useRealTimers());
    it("keeps at most 500ms when the consumer stalls and resumes from recent samples", async () => {
        const { reader, frame, drop } = setup();
        for (let i = 0; i < 10000; i++) frame(i);
        expect(reader.queuedDurationMs).toBe(500);
        expect((await reader.read()).value?.data[0]).toBe(9975);
        expect(drop.mock.calls.reduce((sum, [duration]) => sum + Number(duration), 0)).toBe(199500);
        await reader.cancel();
    });
    it("discards old frames by age, resolves pending reads on cancel and ignores late frames", async () => {
        vi.useFakeTimers();
        const { reader, frame } = setup();
        frame(1);
        await vi.advanceTimersByTimeAsync(501);
        expect(reader.queuedDurationMs).toBe(0);
        const pending = reader.read();
        await reader.cancel();
        frame(2);
        expect(await pending).toEqual({ done: true, value: undefined });
        expect(await reader.read()).toEqual({ done: true, value: undefined });
    });
    it("delivers one waiting consumer directly without a secondary readable-stream queue", async () => {
        const { reader, frame } = setup();
        const pending = reader.read();
        frame(42);
        expect((await pending).value?.data[0]).toBe(42);
        expect(reader.queuedDurationMs).toBe(0);
        await reader.cancel();
    });
});
