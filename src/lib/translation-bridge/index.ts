/**
 * TranslationBridge: Connects a LiveKit room to a Gemini Live API WebSocket
 * for real-time audio translation.
 *
 * Each bridge instance:
 * 1. Joins the LiveKit room as a bot participant (e.g., "translator-es")
 * 2. Subscribes to the organizer's audio track
 * 3. Pipes PCM audio frames to Gemini Live API via WebSocket
 * 4. Receives translated output and publishes enabled audio/text outputs
 */

import {
    type AudioFrame,
    AudioSource,
    AudioStream,
    LocalAudioTrack,
    type RemoteAudioTrack,
    type RemoteParticipant,
    type RemoteTrackPublication,
    Room,
    RoomEvent,
    TrackKind,
    TrackPublishOptions,
    TrackSource,
} from "@livekit/rtc-node";

import { createLogger } from "../logger";
import { GeminiLiveConnection, type GeminiServerMessage } from "./gemini-live-connection";
import { TranslationLatencyMetrics } from "./latency-metrics";
import { TranslationDataPublisher } from "./livekit-data-publisher";
import { TranslatedAudioOutput } from "./translated-audio-output";

export type BridgeStatus = "starting" | "active" | "error" | "closed";

function sanitizeGeminiDebugValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sanitizeGeminiDebugValue);
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => {
                if (key === "data" && typeof entry === "string") {
                    return [key, `[redacted string length=${entry.length}]`];
                }

                return [key, sanitizeGeminiDebugValue(entry)];
            }),
        );
    }

    if (typeof value === "string" && value.length > 500) {
        return `${value.slice(0, 500)}...[truncated length=${value.length}]`;
    }

    return value;
}

function hasGeminiTextDebugSignal(message: unknown): boolean {
    if (typeof message === "string") {
        return /transcription|transcript|caption|text/i.test(message);
    }

    if (Array.isArray(message)) {
        return message.some(hasGeminiTextDebugSignal);
    }

    if (message && typeof message === "object") {
        return Object.entries(message).some(
            ([key, value]) =>
                /transcription|transcript|caption|text/i.test(key) ||
                hasGeminiTextDebugSignal(value),
        );
    }

    return false;
}

function endsWithSentenceBoundary(text: string): boolean {
    return /[.!?。！？؟।]$/u.test(text.trim());
}

export class TranslationBridge {
    private room: Room | null = null;
    private localTrack: LocalAudioTrack | null = null;
    private publishedTrackSid: string = "";
    private transcriptionSegmentId: number = 0;
    private framesSentToGemini: number = 0;
    private framesReceivedFromGemini: number = 0;
    private pendingInterimText: string = "";
    private transcriptionSegmentHasText = false;
    private interimTimeout: NodeJS.Timeout | null = null;
    private geminiDebugMessageCount = 0;

    public readonly targetLanguage: string;
    public readonly sessionId: string;
    public readonly identity: string;
    public status: BridgeStatus = "starting";
    public subscriberCount: number = 0;
    public onStop?: () => void;

    // Gemini Live API config
    private readonly geminiApiKey: string;
    private readonly geminiModel: string = "gemini-3.5-live-translate-preview";
    private readonly sampleRate: number = 24000; // Gemini outputs 24kHz
    // AudioStream resamples the 48kHz LiveKit track before it is sent to Gemini.
    private readonly inputSampleRate: number = 16000;
    private readonly channels: number = 1;
    private readonly contextCompressionTriggerTokens: number = 25000;
    private readonly contextCompressionTargetTokens: number = 8000;
    private readonly outputAudioSourceQueueMs: number = 300;
    private readonly maxOutputBacklogMs: number = 1000;
    private readonly targetOutputBacklogMs: number = 500;
    private readonly outputBacklogLogIntervalMs: number = 5000;
    private readonly outputBacklogInfoThresholdMs: number = 500;
    private readonly latencyLogIntervalMs: number = 5000;
    private readonly geminiOutputIdleThresholdMs: number = 750;

    // LiveKit config
    private readonly livekitUrl: string;
    private readonly livekitApiKey: string;
    private readonly livekitApiSecret: string;
    private readonly enableAudioTranslation: boolean;
    private readonly enableTranscription: boolean;
    private readonly geminiConnection: GeminiLiveConnection;
    private readonly latencyMetrics: TranslationLatencyMetrics;
    private readonly dataPublisher: TranslationDataPublisher;
    private readonly translatedAudioOutput: TranslatedAudioOutput;
    private readonly log;

    private organizerIdentity: string;
    private activeOrganizerAudioPipelineId: string | null = null;

    constructor(
        sessionId: string,
        targetLanguage: string,
        organizerIdentity: string,
        config: {
            geminiApiKey: string;
            livekitUrl: string;
            livekitApiKey: string;
            livekitApiSecret: string;
            enableAudioTranslation?: boolean;
            enableTranscription?: boolean;
        },
    ) {
        this.sessionId = sessionId;
        this.targetLanguage = targetLanguage;
        this.organizerIdentity = organizerIdentity;
        this.identity = `translator-${targetLanguage}`;
        this.geminiApiKey = config.geminiApiKey;
        this.livekitUrl = config.livekitUrl;
        this.livekitApiKey = config.livekitApiKey;
        this.livekitApiSecret = config.livekitApiSecret;
        this.enableAudioTranslation = config.enableAudioTranslation !== false;
        this.enableTranscription = config.enableTranscription === true;
        this.log = createLogger({
            component: "translation-bridge",
            sessionId,
            targetLanguage,
        });
        this.geminiConnection = new GeminiLiveConnection({
            apiKey: this.geminiApiKey,
            model: this.geminiModel,
            targetLanguage,
            enableAudioTranslation: this.enableAudioTranslation,
            enableTranscription: this.enableTranscription,
            contextCompressionTriggerTokens: this.contextCompressionTriggerTokens,
            contextCompressionTargetTokens: this.contextCompressionTargetTokens,
            shouldReconnect: () => this.status === "active",
            onMessage: (message) => this.handleGeminiMessage(message),
        });
        this.dataPublisher = new TranslationDataPublisher({
            targetLanguage,
        });
        this.latencyMetrics = new TranslationLatencyMetrics({
            sessionId,
            targetLanguage,
            inputSampleRate: this.inputSampleRate,
            logIntervalMs: this.latencyLogIntervalMs,
            geminiOutputIdleThresholdMs: this.geminiOutputIdleThresholdMs,
        });
        this.translatedAudioOutput = new TranslatedAudioOutput({
            targetLanguage,
            sampleRate: this.sampleRate,
            channels: this.channels,
            maxBacklogMs: this.maxOutputBacklogMs,
            targetBacklogMs: this.targetOutputBacklogMs,
            backlogLogIntervalMs: this.outputBacklogLogIntervalMs,
            backlogInfoThresholdMs: this.outputBacklogInfoThresholdMs,
            isClosed: () => this.status === "closed",
            onFramePublished: (geminiAudioReceivedAt, publishedAt) => {
                this.latencyMetrics.recordLiveKitAudioPublished(geminiAudioReceivedAt, publishedAt);
                this.latencyMetrics.maybeLog(
                    publishedAt,
                    this.translatedAudioOutput.getTotalBacklogMs(),
                );
            },
        });
    }

    async start(): Promise<void> {
        this.log.info("Starting translation bridge");

        try {
            // 1. Generate token and join LiveKit room
            await this.joinLiveKitRoom();

            // 2. Connect to Gemini Live API
            await this.connectGemini();

            // 3. Subscribe to organizer's audio and wire up the pipeline
            await this.subscribeToOrganizer();

            this.status = "active";
            this.log.info("Translation bridge is active");
        } catch (error) {
            this.log.error({ err: error }, "Failed to start translation bridge");
            this.status = "error";
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.log.info("Stopping translation bridge");
        this.status = "closed";

        if (this.interimTimeout) {
            clearTimeout(this.interimTimeout);
            this.interimTimeout = null;
        }
        this.pendingInterimText = "";

        this.geminiConnection.stop();

        if (this.room) {
            await this.room.disconnect();
            this.room = null;
        }

        this.translatedAudioOutput.detach();
        this.localTrack = null;
        this.activeOrganizerAudioPipelineId = null;

        if (this.onStop) {
            this.onStop();
        }
    }

    private async joinLiveKitRoom(): Promise<void> {
        // Generate a token for the bot participant using the server SDK
        const { AccessToken } = await import("livekit-server-sdk");

        const at = new AccessToken(this.livekitApiKey, this.livekitApiSecret, {
            identity: this.identity,
            name: `Translator (${this.targetLanguage.toUpperCase()})`,
        });

        at.addGrant({
            roomJoin: true,
            room: this.sessionId,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        });

        const token = await at.toJwt();

        // Create and connect to the room
        this.room = new Room();

        this.room.on(RoomEvent.Disconnected, () => {
            this.log.info("Disconnected from LiveKit room");
            this.status = "closed";
        });

        this.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
            if (participant.identity === this.organizerIdentity) {
                this.log.info(
                    { organizerIdentity: this.organizerIdentity },
                    "Organizer disconnected; stopping bridge",
                );
                this.stop().catch((err) => {
                    this.log.error({ err }, "Error stopping bridge after organizer disconnect");
                });
            }
        });

        await this.room.connect(this.livekitUrl, token, {
            autoSubscribe: false,
            dynacast: false,
        });

        this.log.info({ identity: this.identity }, "Joined LiveKit room");

        if (!this.enableAudioTranslation) {
            this.log.info("Translated audio publication disabled");
            return;
        }

        // Create an AudioSource to publish translated audio
        // Gemini outputs 24kHz mono PCM
        const audioSource = new AudioSource(
            this.sampleRate,
            this.channels,
            this.outputAudioSourceQueueMs,
        );
        this.translatedAudioOutput.attach(audioSource);
        this.localTrack = LocalAudioTrack.createAudioTrack(
            `translated-audio-${this.targetLanguage}`,
            audioSource,
        );

        const publishOptions = new TrackPublishOptions();
        publishOptions.source = TrackSource.SOURCE_MICROPHONE;

        await this.room.localParticipant!.publishTrack(this.localTrack, publishOptions);

        // Save published track SID for transcription
        const pubs = this.room.localParticipant!.trackPublications;
        for (const [, pub] of pubs) {
            if (pub.track === this.localTrack) {
                this.publishedTrackSid = pub.sid || "";
                break;
            }
        }

        this.log.info(
            { publishedTrackSid: this.publishedTrackSid || "pending" },
            "Published translated audio track",
        );
    }

    private async connectGemini(): Promise<void> {
        await this.geminiConnection.connect();
    }

    private maybeLogGeminiDebugMessage(message: GeminiServerMessage): void {
        if (this.targetLanguage !== "cs" || !this.enableTranscription) {
            return;
        }

        this.geminiDebugMessageCount++;

        const shouldLog =
            this.geminiDebugMessageCount <= 25 ||
            this.geminiDebugMessageCount % 100 === 0 ||
            hasGeminiTextDebugSignal(message);

        if (!shouldLog) return;

        this.log.info(
            {
                debugMessageCount: this.geminiDebugMessageCount,
                geminiMessage: sanitizeGeminiDebugValue(message),
            },
            "Gemini raw debug message",
        );
    }

    private handleGeminiMessage(message: GeminiServerMessage): void {
        try {
            this.maybeLogGeminiDebugMessage(message);

            // Handle audio response
            const serverContent = message?.serverContent;
            const parts = serverContent?.modelTurn?.parts;
            const modelTurnText = parts
                ?.map((part) => part.text)
                .filter((text): text is string => Boolean(text))
                .join("");
            const outputTranscription =
                serverContent?.outputTranscription ?? message.outputTranscription;
            const isOutputTranscriptionComplete =
                outputTranscription?.finished === true || serverContent?.turnComplete === true;

            if (parts?.length) {
                for (const part of parts) {
                    if (part.inlineData?.data) {
                        const receivedAt = Date.now();
                        this.framesReceivedFromGemini++;
                        if (
                            this.framesReceivedFromGemini <= 3 ||
                            this.framesReceivedFromGemini % 100 === 0
                        ) {
                            this.log.info(
                                {
                                    base64Bytes: part.inlineData.data.length,
                                    frameNumber: this.framesReceivedFromGemini,
                                    publicationEnabled: this.enableAudioTranslation,
                                },
                                "Received audio frame from Gemini",
                            );
                        }
                        if (!this.enableAudioTranslation) {
                            continue;
                        }
                        this.latencyMetrics.recordGeminiAudioReceived(receivedAt);
                        // Queue frame for sequential capture (avoid promise pile-up)
                        this.translatedAudioOutput.enqueue(
                            part.inlineData.data,
                            receivedAt,
                            this.framesReceivedFromGemini,
                        );
                    }
                }
            }

            // Handle output transcription. Gemini may send it inside serverContent
            // or as a top-level server message, depending on the Live API surface.
            let publishedFinalTranscription = false;
            if (this.enableTranscription && outputTranscription?.text) {
                const shouldComplete =
                    isOutputTranscriptionComplete ||
                    endsWithSentenceBoundary(outputTranscription.text);
                publishedFinalTranscription = this.handleOutputTranscriptionText(
                    outputTranscription.text,
                    shouldComplete,
                );
                if (publishedFinalTranscription && !isOutputTranscriptionComplete) {
                    this.completeCurrentTranscriptionSegment();
                }
            } else if (this.enableTranscription && modelTurnText) {
                // Some Live API surfaces expose the translated text as modelTurn text
                // parts instead of the dedicated outputTranscription field.
                const shouldComplete =
                    serverContent?.turnComplete === true || endsWithSentenceBoundary(modelTurnText);
                publishedFinalTranscription = this.handleOutputTranscriptionText(
                    modelTurnText,
                    shouldComplete,
                );
                if (publishedFinalTranscription && serverContent?.turnComplete !== true) {
                    this.completeCurrentTranscriptionSegment();
                }
            }

            // If turn is complete, flush remaining interim buffer and advance the segment id
            if (
                this.enableTranscription &&
                (serverContent?.turnComplete || outputTranscription?.finished)
            ) {
                if (this.interimTimeout) {
                    clearTimeout(this.interimTimeout);
                    this.interimTimeout = null;
                }
                if (this.pendingInterimText) {
                    void this.dataPublisher.publishTranscription(
                        this.room,
                        this.pendingInterimText,
                        false,
                        this.transcriptionSegmentId,
                    );
                    this.pendingInterimText = "";
                    this.transcriptionSegmentHasText = true;
                } else if (this.transcriptionSegmentHasText && !publishedFinalTranscription) {
                    void this.dataPublisher.publishTranscription(
                        this.room,
                        "",
                        false,
                        this.transcriptionSegmentId,
                    );
                }
                this.completeCurrentTranscriptionSegment();
            }
        } catch (error) {
            this.log.error({ err: error }, "Error handling Gemini message");
        }
    }

    private async subscribeToOrganizer(): Promise<void> {
        if (!this.room) return;

        // Find the organizer participant and subscribe to their audio
        const participants = this.room.remoteParticipants;

        for (const [, participant] of participants) {
            if (participant.identity === this.organizerIdentity) {
                this.subscribeToParticipantAudio(participant);
                return;
            }
        }

        // If organizer hasn't joined yet, wait for them
        this.log.info({ organizerIdentity: this.organizerIdentity }, "Waiting for organizer");

        // Listen for the organizer to publish their track
        this.room.on(
            RoomEvent.TrackPublished,
            (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
                if (
                    participant.identity === this.organizerIdentity &&
                    publication.kind === TrackKind.KIND_AUDIO
                ) {
                    const preferredPublication = this.selectOrganizerAudioPublication(participant);

                    if (preferredPublication === publication) {
                        publication.setSubscribed(true);
                    } else {
                        this.log.info(
                            {
                                preferredPublication: preferredPublication
                                    ? this.getPublicationLabel(preferredPublication)
                                    : "none",
                                publication: this.getPublicationLabel(publication),
                            },
                            "Ignoring non-preferred organizer audio publication",
                        );
                    }
                }
            },
        );

        // Once subscribed, pipe to Gemini
        this.room.on(
            RoomEvent.TrackSubscribed,
            (
                track: RemoteAudioTrack,
                publication: RemoteTrackPublication,
                participant: RemoteParticipant,
            ) => {
                if (
                    participant.identity === this.organizerIdentity &&
                    publication.kind === TrackKind.KIND_AUDIO
                ) {
                    this.pipeTrackToGemini(track, publication);
                }
            },
        );
    }

    /**
     * Manually subscribe to a participant's audio track (needed when autoSubscribe is off).
     */
    private subscribeToParticipantAudio(participant: RemoteParticipant): void {
        // Listen before setSubscribed() so the subscription event cannot race past us.
        this.room!.on(
            RoomEvent.TrackSubscribed,
            (track: RemoteAudioTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
                if (p.identity === this.organizerIdentity && pub.kind === TrackKind.KIND_AUDIO) {
                    this.pipeTrackToGemini(track, pub);
                }
            },
        );

        const preferredPublication = this.selectOrganizerAudioPublication(participant);

        if (!preferredPublication) {
            this.log.info(
                { organizerIdentity: this.organizerIdentity },
                "Organizer has no audio tracks yet",
            );
            return;
        }

        this.log.info(
            { publication: this.getPublicationLabel(preferredPublication) },
            "Subscribing to organizer audio publication",
        );
        preferredPublication.setSubscribed(true);
    }

    private selectOrganizerAudioPublication(
        participant: RemoteParticipant,
    ): RemoteTrackPublication | undefined {
        const audioPublications = Array.from(participant.trackPublications.values()).filter(
            (publication) => publication.kind === TrackKind.KIND_AUDIO,
        );
        const broadcastPublications = audioPublications.filter(
            (publication) => publication.name === "broadcast-audio",
        );
        const candidates =
            broadcastPublications.length > 0 ? broadcastPublications : audioPublications;

        if (broadcastPublications.length > 1) {
            this.log.warn(
                {
                    publications: broadcastPublications.map((publication) =>
                        this.getPublicationLabel(publication),
                    ),
                },
                "Found duplicate organizer broadcast-audio publications",
            );
        }

        return (
            candidates.find((publication) => publication.muted === false) ??
            candidates.find((publication) => publication.muted !== true) ??
            candidates[0]
        );
    }

    private pipeTrackToGemini(track: RemoteAudioTrack, publication: RemoteTrackPublication): void {
        const pipelineId = this.getAudioPipelineId(track, publication);

        if (this.activeOrganizerAudioPipelineId) {
            const duplicateKind =
                this.activeOrganizerAudioPipelineId === pipelineId ? "duplicate" : "additional";
            this.log.warn(
                {
                    activePipelineId: this.activeOrganizerAudioPipelineId,
                    duplicateKind,
                    pipelineId,
                },
                "Ignoring organizer audio pipeline while another pipeline is active",
            );
            return;
        }

        this.activeOrganizerAudioPipelineId = pipelineId;
        this.log.info(
            {
                pipelineId,
                publication: this.getPublicationLabel(publication),
            },
            "Subscribed to organizer audio track; piping to Gemini",
        );

        const audioStream = new AudioStream(track, {
            sampleRate: this.inputSampleRate,
            numChannels: this.channels,
            frameSizeMs: 100,
        });

        // Process frames as they arrive via ReadableStream reader
        const reader = audioStream.getReader();
        const readLoop = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                this.sendAudioToGemini(value);
            }
        };

        readLoop()
            .catch((err: Error) => {
                this.log.error({ err }, "Audio stream error");
            })
            .finally(() => {
                if (this.activeOrganizerAudioPipelineId === pipelineId) {
                    this.activeOrganizerAudioPipelineId = null;
                }
            });
    }

    private getAudioPipelineId(
        track: RemoteAudioTrack,
        publication: RemoteTrackPublication,
    ): string {
        return publication.sid || track.sid || publication.name || track.name || "unknown";
    }

    private getPublicationLabel(publication: RemoteTrackPublication): string {
        return `sid=${publication.sid || "unknown"}, name=${publication.name || "unnamed"}, muted=${publication.muted ?? "unknown"}, subscribed=${publication.subscribed}`;
    }

    private sendAudioToGemini(frame: AudioFrame): void {
        if (!this.geminiConnection.isReady) {
            return;
        }

        try {
            const frameReceivedAt = Date.now();
            // Convert AudioFrame's Int16Array data to base64
            const int16Data = frame.data;
            const buffer = Buffer.from(
                int16Data.buffer,
                int16Data.byteOffset,
                int16Data.byteLength,
            );
            const base64 = buffer.toString("base64");

            this.framesSentToGemini++;
            if (this.framesSentToGemini <= 3 || this.framesSentToGemini % 500 === 0) {
                this.log.info(
                    {
                        base64Bytes: base64.length,
                        frameNumber: this.framesSentToGemini,
                        samples: int16Data.length,
                    },
                    "Sent audio frame to Gemini",
                );
            }

            this.geminiConnection.sendAudio(base64, this.inputSampleRate);
            const sentAt = Date.now();
            this.latencyMetrics.recordInputSent(frameReceivedAt, sentAt);
            this.latencyMetrics.maybeLog(sentAt, this.translatedAudioOutput.getTotalBacklogMs());
        } catch (error) {
            this.log.error({ err: error }, "Error sending audio to Gemini");
        }
    }

    private handleInterimTranscription(text: string): void {
        if (!this.enableTranscription) return;

        this.pendingInterimText += text;

        if (!this.interimTimeout) {
            this.interimTimeout = setTimeout(() => {
                this.flushInterimTranscription();
            }, 150); // Throttle interim text updates to 150ms
        }
    }

    private handleOutputTranscriptionText(text: string, isComplete: boolean): boolean {
        if (!this.enableTranscription) return false;

        if (!isComplete) {
            this.handleInterimTranscription(text);
            return false;
        }

        if (this.interimTimeout) {
            clearTimeout(this.interimTimeout);
            this.interimTimeout = null;
        }
        const finalText = this.pendingInterimText + text;
        this.pendingInterimText = "";
        this.transcriptionSegmentHasText = true;
        this.log.info({ textPreview: finalText.slice(0, 100) }, "Final transcription received");
        void this.dataPublisher.publishTranscription(
            this.room,
            finalText,
            false,
            this.transcriptionSegmentId,
        );
        return true;
    }

    private completeCurrentTranscriptionSegment(): void {
        this.transcriptionSegmentHasText = false;
        this.transcriptionSegmentId++;
    }

    private flushInterimTranscription(): void {
        this.interimTimeout = null;
        if (this.enableTranscription && this.pendingInterimText && this.status === "active") {
            this.transcriptionSegmentHasText = true;
            void this.dataPublisher.publishTranscription(
                this.room,
                this.pendingInterimText,
                true,
                this.transcriptionSegmentId,
            );
            this.pendingInterimText = "";
        }
    }
}
