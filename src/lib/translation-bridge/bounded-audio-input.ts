import { createRequire } from "node:module";
import type { ReadableStreamReadResult } from "node:stream/web";

import type { AudioFrame, RemoteAudioTrack } from "@livekit/rtc-node";

const MAX_INPUT_QUEUE_MS = 500;
type QueuedInput = { frame: AudioFrame; receivedAt: number; durationMs: number };
type SourceController = { enqueue(frame: AudioFrame): void; close(): void };
type NativeSource = { start(controller: SourceController): void; cancel(): void };

export type AudioInputReader = {
    read(): Promise<ReadableStreamReadResult<AudioFrame>>;
    cancel(): Promise<void>;
    releaseLock(): void;
};

/**
 * rtc-node 0.13.33's public AudioStream unconditionally enqueues frames and exposes no
 * capacity setting. Reuse its native source/lifecycle with our bounded controller.
 * This is the only internal SDK adapter; rtc-node is pinned and this contract is tested.
 */
function createNativeSource(track: RemoteAudioTrack, sampleRate: number): NativeSource {
    const rtcRequire = createRequire(require.resolve("@livekit/rtc-node"));
    const { AudioStreamSource } = rtcRequire("./audio_stream.cjs") as {
        AudioStreamSource: new (
            track: RemoteAudioTrack,
            options: {
                sampleRate: number;
                numChannels: number;
                frameSizeMs: number;
            },
        ) => NativeSource;
    };
    return new AudioStreamSource(track, { sampleRate, numChannels: 1, frameSizeMs: 20 });
}

export class BoundedAudioInput implements AudioInputReader {
    private pending: QueuedInput[] = [];
    private pendingMs = 0;
    private ended = false;
    private waiting: ((value: ReadableStreamReadResult<AudioFrame>) => void) | null = null;
    private readonly arrivalTimes = new WeakMap<AudioFrame, number>();
    private readonly source: NativeSource;

    constructor(
        track: RemoteAudioTrack,
        sampleRate: number,
        private readonly onDrop: (ms: number) => void,
        sourceFactory = createNativeSource,
    ) {
        this.source = sourceFactory(track, sampleRate);
        this.source.start({ enqueue: (frame) => this.enqueue(frame), close: () => this.finish() });
    }

    receivedAt(frame: AudioFrame): number {
        return this.arrivalTimes.get(frame) ?? performance.now();
    }
    get queuedDurationMs(): number {
        this.trim();
        return this.pendingMs;
    }

    read(): Promise<ReadableStreamReadResult<AudioFrame>> {
        this.trim();
        const queued = this.pending.shift();
        if (queued) {
            this.pendingMs -= queued.durationMs;
            return Promise.resolve({ done: false, value: queued.frame });
        }
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        if (this.waiting) return Promise.reject(new Error("Only one audio reader is allowed"));
        return new Promise((resolve) => {
            this.waiting = resolve;
        });
    }

    async cancel(): Promise<void> {
        this.onDrop(this.pendingMs);
        this.pending = [];
        this.pendingMs = 0;
        this.source.cancel();
        this.finish();
    }
    releaseLock(): void {
        /* Ownership belongs to this single consumer until cancel/EOS. */
    }

    private enqueue(frame: AudioFrame): void {
        if (this.ended) return;
        const receivedAt = performance.now();
        const durationMs = (frame.samplesPerChannel / frame.sampleRate) * 1000;
        this.arrivalTimes.set(frame, receivedAt);
        this.pending.push({ frame, receivedAt, durationMs });
        this.pendingMs += durationMs;
        this.trim();
        const queued = this.waiting ? this.pending.shift() : undefined;
        if (queued) {
            this.pendingMs -= queued.durationMs;
            const resolve = this.waiting!;
            this.waiting = null;
            resolve({ done: false, value: queued.frame });
        }
    }

    private trim(): void {
        const now = performance.now();
        let dropped = 0;
        while (
            this.pending.length &&
            (this.pendingMs > MAX_INPUT_QUEUE_MS ||
                now - this.pending[0]!.receivedAt > MAX_INPUT_QUEUE_MS)
        ) {
            const old = this.pending.shift()!;
            this.pendingMs -= old.durationMs;
            dropped += old.durationMs;
        }
        if (dropped) this.onDrop(dropped);
    }

    private finish(): void {
        this.ended = true;
        this.waiting?.({ done: true, value: undefined });
        this.waiting = null;
    }
}
