import type { Room } from "@livekit/rtc-node";

import { createLogger } from "../logger";
import { participantWantsTranslation } from "./participant-attributes";

export type TranslationDataPublisherOptions = {
    targetLanguage: string;
};

/** Publishes translated text through LiveKit data channels. */
export class TranslationDataPublisher {
    private readonly log;
    private readonly options: TranslationDataPublisherOptions;

    constructor(options: TranslationDataPublisherOptions) {
        this.options = options;
        this.log = createLogger({
            component: "translation-data-publisher",
            targetLanguage: options.targetLanguage,
        });
    }

    async publishTranscription(
        room: Room | null,
        text: string,
        interim: boolean,
        segmentId: number,
    ): Promise<void> {
        if (!room?.localParticipant) return;

        try {
            const destinationIdentities = Array.from(room.remoteParticipants.values())
                .filter((participant) =>
                    participantWantsTranslation(
                        participant.attributes,
                        this.options.targetLanguage,
                    ),
                )
                .map((participant) => participant.identity);

            const payload = JSON.stringify({
                type: "transcription",
                language: this.options.targetLanguage,
                segmentId: `${this.options.targetLanguage}-${segmentId}`,
                text,
                final: !interim,
                timestamp: Date.now(),
            });

            await room.localParticipant.publishData(new TextEncoder().encode(payload), {
                reliable: true,
                topic: "transcription",
                ...(destinationIdentities.length > 0
                    ? { destination_identities: destinationIdentities }
                    : {}),
            });
        } catch (error) {
            this.log.error({ err: error }, "Error publishing transcription");
        }
    }
}
