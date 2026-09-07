import { AudioFrame, type AudioSource } from "@livekit/rtc-node";

import { createLogger } from "../logger";

type QueuedFrame = {
    pcm: Int16Array;
    receivedAt: number;
    sequenceNumber: number;
    startSample: number;
};

export type TranslatedAudioOutputOptions = {
    targetLanguage: string;
    sampleRate: number;
    channels: number;
    maxBacklogMs: number;
    targetBacklogMs: number;
    backlogLogIntervalMs: number;
    backlogInfoThresholdMs: number;
    isClosed: () => boolean;
    onFramePublished: (receivedAt: number, publishedAt: number) => void;
};

/** Bounded output in 20ms blocks. The server queue is not end-to-end translation latency. */
export class TranslatedAudioOutput {
    private audioSource: AudioSource | null = null;
    private pending: QueuedFrame[] = [];
    private pendingSamples = 0;
    private nextSample = 0;
    private publishing = false;
    private inFlightMs = 0;
    private maxBacklogMs: number;
    private droppedDurationMs = 0;
    private lastDropAt = -Infinity;
    private lastSample = 0;
    private smoothNext = false;
    private generation = 0;
    private readonly log;

    constructor(private readonly options: TranslatedAudioOutputOptions) {
        this.maxBacklogMs = options.maxBacklogMs;
        this.log = createLogger({
            component: "translated-audio-output",
            targetLanguage: options.targetLanguage,
        });
    }

    attach(source: AudioSource): void {
        this.audioSource = source;
    }

    setMaxBacklogMs(value: number): void {
        this.maxBacklogMs = value;
        this.trim();
    }

    detach(): void {
        this.generation++;
        this.audioSource = null;
        this.pending = [];
        this.pendingSamples = 0;
    }

    async close(): Promise<void> {
        const source = this.audioSource;
        this.detach();
        if (source) {
            source.clearQueue();
            await source.close();
        }
    }

    clear(): void {
        this.recordDrop(this.getTotalBacklogMs(), "stream-reset");
        this.pending = [];
        this.pendingSamples = 0;
        // During capture, wait for the single publisher before touching the native queue.
        this.clearNativeRequested = true;
        if (!this.publishing) this.clearNative();
        this.smoothNext = true;
    }

    private clearNativeRequested = false;
    private clearNative(): void {
        this.audioSource?.clearQueue();
        this.clearNativeRequested = false;
    }

    getTotalBacklogMs(): number {
        return (
            this.ms(this.pendingSamples) +
            Math.max(this.audioSource?.queuedDuration ?? 0, this.inFlightMs)
        );
    }

    getDiagnostics() {
        return {
            outputBacklogMs: Math.round(this.getTotalBacklogMs()),
            droppedOutputMs: Math.round(this.droppedDurationMs),
            playbackSpeed: 1,
            state:
                performance.now() - this.lastDropAt < 2000
                    ? ("dropping" as const)
                    : ("normal" as const),
        };
    }

    enqueue(base64Audio: string, receivedAt: number, sequenceNumber: number): void {
        if (!this.audioSource || this.options.isClosed()) return;
        const bytes = Buffer.from(base64Audio, "base64");
        if (bytes.length % 2 !== 0) {
            this.log.warn("Discarded malformed PCM audio");
            return;
        }
        const samplesPerBlock = (this.options.sampleRate * this.options.channels) / 50;
        for (let offset = 0; offset < bytes.length; offset += samplesPerBlock * 2) {
            const block = bytes.subarray(offset, offset + samplesPerBlock * 2);
            // Own only this block; a small retained view must not keep a huge Gemini response alive.
            const pcm = new Int16Array(block.length / 2);
            for (let index = 0; index < pcm.length; index++)
                pcm[index] = block.readInt16LE(index * 2);
            this.pending.push({ pcm, receivedAt, sequenceNumber, startSample: this.nextSample });
            this.nextSample += pcm.length;
            this.pendingSamples += pcm.length;
            this.trim();
        }
        if (!this.publishing) void this.drain();
    }

    private ms(samples: number): number {
        return (samples / this.options.channels / this.options.sampleRate) * 1000;
    }

    private recordDrop(
        durationMs: number,
        reason: string,
        fromSample?: number,
        toSample?: number,
    ): void {
        if (durationMs <= 0) return;
        const now = performance.now();
        if (now - this.lastDropAt > 2000) {
            this.log.warn(
                { droppedDurationMs: Math.round(durationMs), reason, fromSample, toSample },
                "Output audio backlog capped",
            );
        }
        this.lastDropAt = now;
        this.droppedDurationMs += durationMs;
    }

    private trim(): void {
        if (this.getTotalBacklogMs() <= this.maxBacklogMs) return;
        const targetMs = this.maxBacklogMs * 0.5;
        let droppedSamples = 0;
        const first = this.pending[0]?.startSample;
        while (this.pending.length && this.getTotalBacklogMs() > targetMs) {
            const old = this.pending.shift()!;
            this.pendingSamples -= old.pcm.length;
            droppedSamples += old.pcm.length;
        }
        // Prefer a quiet transition within another 100ms, with bounded extra loss.
        let extra = 0;
        while (this.pending.length > 1 && extra < this.options.sampleRate * 0.1) {
            const frame = this.pending[0]!;
            const peak = frame.pcm.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
            if (peak < 500) break;
            // Only skip to a nearby quiet block when it actually exists.
            if (
                !this.pending
                    .slice(1, 6)
                    .some((candidate) => candidate.pcm.every((sample) => Math.abs(sample) < 500))
            )
                break;
            this.pending.shift();
            this.pendingSamples -= frame.pcm.length;
            droppedSamples += frame.pcm.length;
            extra += frame.pcm.length;
        }
        if (droppedSamples) {
            this.recordDrop(
                this.ms(droppedSamples),
                "queue-limit",
                first,
                first === undefined ? undefined : first + droppedSamples,
            );
            this.smoothNext = true;
        }
    }

    private async drain(): Promise<void> {
        if (this.publishing) return;
        this.publishing = true;
        const generation = this.generation;
        try {
            while (
                this.pending.length &&
                !this.options.isClosed() &&
                generation === this.generation
            ) {
                if (this.clearNativeRequested) this.clearNative();
                this.trim();
                const queued = this.pending.shift();
                const source = this.audioSource;
                if (!queued || !source) break;
                this.pendingSamples -= queued.pcm.length;
                const pcm = queued.pcm;
                if (this.smoothNext) {
                    const fadeSamples = Math.min(
                        pcm.length,
                        Math.round(this.options.sampleRate * 0.005),
                    );
                    for (let i = 0; i < fadeSamples; i++) {
                        const mix = (i + 1) / fadeSamples;
                        pcm[i] = Math.round(this.lastSample * (1 - mix) + pcm[i]! * mix);
                    }
                    this.smoothNext = false;
                }
                this.inFlightMs = this.ms(pcm.length);
                await source.captureFrame(
                    new AudioFrame(
                        pcm,
                        this.options.sampleRate,
                        this.options.channels,
                        pcm.length / this.options.channels,
                    ),
                );
                this.inFlightMs = 0;
                if (generation !== this.generation) break;
                this.lastSample = pcm[pcm.length - 1] ?? 0;
                this.options.onFramePublished(queued.receivedAt, performance.now());
            }
        } catch (error) {
            if (!this.options.isClosed())
                this.log.error({ err: error }, "Audio publication failed");
        } finally {
            this.inFlightMs = 0;
            this.publishing = false;
            if (this.clearNativeRequested && this.audioSource) this.clearNative();
        }
    }
}
