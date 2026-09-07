import { randomUUID } from "node:crypto";

import type { Room } from "@livekit/rtc-node";

import { createLogger } from "../logger";
import { participantWantsTranslation } from "./participant-attributes";

export type TranslationDataPublisherOptions = {
    targetLanguage: string;
    streamEpoch?: number;
    onPublicationError?: () => void;
};

const MAX_SEGMENT_CODEPOINTS = 1200;
const MAX_PENDING_SEGMENTS = 50;

type Snapshot = {
    type: "transcription";
    protocolVersion: 2;
    updateType: "replace";
    streamId: string;
    streamEpoch: number;
    streamGeneration: number;
    sequence: number;
    segmentOrder: number;
    segmentId: string;
    revision: number;
    language: string;
    // Legacy consumers still receive a delta. Version 2 consumers use snapshotText.
    text: string;
    snapshotText: string;
    final: boolean;
    timestamp: number;
};

/** Bounded, coalescing text delivery; audio never waits for a data channel write. */
export class TranslationDataPublisher {
    private readonly log;
    private streamId = randomUUID();
    private streamGeneration = 0;
    private sequence = 0;
    private segmentOrder = 0;
    private sourceSegment: number | null = null;
    private revision = 0;
    private text = "";
    private final = false;
    private pending = new Map<string, { room: Room; snapshot: Snapshot }>();
    private sending: Promise<void> | null = null;
    private stopped = false;
    private cancelWrite: (() => void) | null = null;
    private droppedCaptionSegments = 0;
    private failedCaptionUpdates = 0;

    constructor(private readonly options: TranslationDataPublisherOptions) {
        this.log = createLogger({
            component: "translation-data-publisher",
            targetLanguage: options.targetLanguage,
        });
    }

    getDiagnostics() {
        return {
            droppedCaptionSegments: this.droppedCaptionSegments,
            failedCaptionUpdates: this.failedCaptionUpdates,
        };
    }

    resetStream(): void {
        this.streamId = randomUUID();
        this.streamGeneration++;
        this.sourceSegment = null;
        this.text = "";
        this.revision = 0;
        this.final = false;
        this.pending.clear();
    }

    stop(): void {
        this.stopped = true;
        this.pending.clear();
        this.cancelWrite?.();
    }

    publishTranscription(
        room: Room | null,
        delta: string,
        interim: boolean,
        segmentId: number,
    ): Promise<void> {
        if (this.stopped || !room?.localParticipant) return Promise.resolve();
        if (this.sourceSegment !== segmentId) {
            if (this.text && !this.final) this.queue(room, "", true);
            this.sourceSegment = segmentId;
            this.newSegment();
        }
        const characters = Array.from(delta);
        let offset = 0;
        do {
            if (
                Array.from(this.text).length >= MAX_SEGMENT_CODEPOINTS &&
                offset < characters.length
            ) {
                this.queue(room, "", true);
                this.newSegment();
            }
            const capacity = MAX_SEGMENT_CODEPOINTS - Array.from(this.text).length;
            const next = characters.slice(offset, offset + capacity).join("");
            offset += Array.from(next).length;
            this.text += next;
            const more = offset < characters.length;
            if (this.text) this.queue(room, next, more || !interim);
        } while (offset < characters.length);
        if (!this.sending) {
            // Defer the drain so sending is assigned even when publishing fails synchronously.
            this.sending = Promise.resolve().then(() => this.drain());
        }
        return this.sending;
    }

    private newSegment(): void {
        this.segmentOrder++;
        this.revision = 0;
        this.text = "";
        this.final = false;
    }

    private queue(room: Room, delta: string, final: boolean): void {
        this.final ||= final;
        const segmentId = `${this.options.targetLanguage}-${this.streamId}-${this.segmentOrder}`;
        const previous = this.pending.get(segmentId);
        const snapshot: Snapshot = {
            type: "transcription",
            protocolVersion: 2,
            updateType: "replace",
            streamId: this.streamId,
            streamEpoch: this.options.streamEpoch ?? 0,
            streamGeneration: this.streamGeneration,
            sequence: ++this.sequence,
            segmentOrder: this.segmentOrder,
            segmentId,
            revision: ++this.revision,
            language: this.options.targetLanguage,
            text: (previous?.snapshot.text ?? "") + delta,
            snapshotText: this.text,
            final: this.final,
            timestamp: Date.now(),
        };
        this.pending.set(segmentId, { room, snapshot });
        if (this.pending.size > MAX_PENDING_SEGMENTS) {
            this.pending.delete(this.pending.keys().next().value!);
            this.droppedCaptionSegments++;
            this.log.warn("Slow caption delivery: discarded oldest pending segment");
        }
    }

    private async drain(): Promise<void> {
        try {
            while (!this.stopped && this.pending.size) {
                const [id, { room, snapshot }] = this.pending.entries().next().value!;
                this.pending.delete(id);
                const destinationIdentities = Array.from(room.remoteParticipants.values())
                    .filter((participant) =>
                        participantWantsTranslation(
                            participant.attributes,
                            this.options.targetLanguage,
                        ),
                    )
                    .map((participant) => participant.identity);
                let timeout: NodeJS.Timeout | undefined;
                let cancel!: () => void;
                const cancelled = new Promise<void>((resolve) => {
                    cancel = resolve;
                });
                this.cancelWrite = cancel;
                try {
                    const publish = room.localParticipant?.publishData(
                        new TextEncoder().encode(JSON.stringify(snapshot)),
                        {
                            reliable: true,
                            topic: "transcription",
                            ...(destinationIdentities.length
                                ? { destination_identities: destinationIdentities }
                                : {}),
                        },
                    );
                    await Promise.race([
                        publish,
                        cancelled,
                        new Promise<never>((_, reject) => {
                            timeout = setTimeout(
                                () => reject(new Error("Caption publication stalled for 5s")),
                                5000,
                            );
                            timeout.unref();
                        }),
                    ]);
                } catch (error) {
                    this.failedCaptionUpdates++;
                    this.log.error({ err: error }, "Error publishing transcription");
                    this.stop();
                    this.options.onPublicationError?.();
                } finally {
                    if (timeout) clearTimeout(timeout);
                    if (this.cancelWrite === cancel) this.cancelWrite = null;
                }
            }
        } finally {
            this.sending = null;
        }
    }
}
