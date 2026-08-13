import { createLogger } from "../logger";

type LatencyStatistic = {
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
};

type LatencyMetricsWindow = {
    inputFrames: number;
    outputFrames: number;
    bridgeInputEncodeMs: LatencyStatistic;
    geminiFirstAudioAfterIdleMs: LatencyStatistic;
    geminiToLiveKitPublishMs: LatencyStatistic;
};

export type TranslationLatencyMetricsOptions = {
    sessionId: string;
    targetLanguage: string;
    inputSampleRate: number;
    logIntervalMs: number;
    geminiOutputIdleThresholdMs: number;
};

function createLatencyStatistic(): LatencyStatistic {
    return {
        count: 0,
        totalMs: 0,
        minMs: Number.POSITIVE_INFINITY,
        maxMs: 0,
    };
}

function createLatencyMetricsWindow(): LatencyMetricsWindow {
    return {
        inputFrames: 0,
        outputFrames: 0,
        bridgeInputEncodeMs: createLatencyStatistic(),
        geminiFirstAudioAfterIdleMs: createLatencyStatistic(),
        geminiToLiveKitPublishMs: createLatencyStatistic(),
    };
}

/**
 * Aggregates timings that are observable inside the translation bridge. These
 * measurements deliberately exclude the final LiveKit-to-listener network leg.
 */
export class TranslationLatencyMetrics {
    private metrics = createLatencyMetricsWindow();
    private windowStartedAt = Date.now();
    private lastLogAt = 0;
    private lastGeminiAudioReceivedAt = 0;
    private firstInputAfterGeminiOutputIdleAt: number | null = null;
    private readonly log;

    private readonly options: TranslationLatencyMetricsOptions;

    constructor(options: TranslationLatencyMetricsOptions) {
        this.options = options;
        this.log = createLogger({
            component: "translation-latency-metrics",
            sessionId: options.sessionId,
            targetLanguage: options.targetLanguage,
        });
    }

    recordInputSent(frameReceivedAt: number, sentAt: number): void {
        this.metrics.inputFrames++;
        this.recordLatency(this.metrics.bridgeInputEncodeMs, sentAt - frameReceivedAt);

        if (
            this.firstInputAfterGeminiOutputIdleAt === null &&
            (this.lastGeminiAudioReceivedAt === 0 ||
                sentAt - this.lastGeminiAudioReceivedAt >= this.options.geminiOutputIdleThresholdMs)
        ) {
            this.firstInputAfterGeminiOutputIdleAt = sentAt;
        }
    }

    recordGeminiAudioReceived(receivedAt: number): void {
        this.metrics.outputFrames++;

        if (this.firstInputAfterGeminiOutputIdleAt !== null) {
            this.recordLatency(
                this.metrics.geminiFirstAudioAfterIdleMs,
                receivedAt - this.firstInputAfterGeminiOutputIdleAt,
            );
            this.firstInputAfterGeminiOutputIdleAt = null;
        }

        this.lastGeminiAudioReceivedAt = receivedAt;
    }

    recordLiveKitAudioPublished(geminiAudioReceivedAt: number, publishedAt: number): void {
        this.recordLatency(
            this.metrics.geminiToLiveKitPublishMs,
            publishedAt - geminiAudioReceivedAt,
        );
    }

    maybeLog(now: number, outputBacklogMs: number): void {
        if (now - this.lastLogAt < this.options.logIntervalMs) return;
        if (this.metrics.inputFrames === 0 && this.metrics.outputFrames === 0) {
            return;
        }

        const metrics = this.metrics;
        const windowStartedAt = this.windowStartedAt;
        this.lastLogAt = now;
        this.windowStartedAt = now;
        this.metrics = createLatencyMetricsWindow();

        this.log.info(
            {
                event: "translation_latency",
                windowMs: now - windowStartedAt,
                inputSampleRate: this.options.inputSampleRate,
                inputFrames: metrics.inputFrames,
                outputFrames: metrics.outputFrames,
                bridgeInputEncodeMs: this.summarize(metrics.bridgeInputEncodeMs),
                geminiFirstAudioAfterIdleMs: this.summarize(metrics.geminiFirstAudioAfterIdleMs),
                geminiToLiveKitPublishMs: this.summarize(metrics.geminiToLiveKitPublishMs),
                outputBacklogMs: Math.round(outputBacklogMs),
            },
            "Translation latency metrics",
        );
    }

    private recordLatency(statistic: LatencyStatistic, durationMs: number): void {
        const normalizedDurationMs = Math.max(0, durationMs);
        statistic.count++;
        statistic.totalMs += normalizedDurationMs;
        statistic.minMs = Math.min(statistic.minMs, normalizedDurationMs);
        statistic.maxMs = Math.max(statistic.maxMs, normalizedDurationMs);
    }

    private summarize(statistic: LatencyStatistic) {
        if (statistic.count === 0) return null;

        return {
            count: statistic.count,
            avg: Math.round(statistic.totalMs / statistic.count),
            min: Math.round(statistic.minMs),
            max: Math.round(statistic.maxMs),
        };
    }
}
