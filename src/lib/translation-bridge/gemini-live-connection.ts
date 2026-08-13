import WebSocket from "ws";

import { createLogger } from "../logger";

export type GeminiTranscription = {
    text?: string;
    finished?: boolean;
};

export type GeminiServerMessage = {
    setupComplete?: Record<string, never>;
    sessionResumptionUpdate?: {
        resumable?: boolean;
        newHandle?: string;
    };
    goAway?: {
        timeLeft?: string;
    };
    serverContent?: {
        modelTurn?: {
            parts?: Array<{
                text?: string;
                inlineData?: {
                    data?: string;
                };
            }>;
        };
        outputTranscription?: GeminiTranscription;
        turnComplete?: boolean;
    };
    outputTranscription?: GeminiTranscription;
};

export type GeminiLiveConnectionOptions = {
    apiKey: string;
    model: string;
    targetLanguage: string;
    enableAudioTranslation: boolean;
    enableTranscription: boolean;
    contextCompressionTriggerTokens: number;
    contextCompressionTargetTokens: number;
    shouldReconnect: () => boolean;
    onMessage: (message: GeminiServerMessage) => void;
    webSocketFactory?: (url: string) => WebSocket;
};

type GeminiSetup = {
    model: string;
    outputAudioTranscription?: Record<string, never>;
    generationConfig: {
        responseModalities: string[];
        translationConfig: {
            targetLanguageCode: string;
            echoTargetLanguage: boolean;
        };
    };
    realtimeInputConfig: {
        automaticActivityDetection: {
            disabled: boolean;
            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH";
            endOfSpeechSensitivity: "END_SENSITIVITY_HIGH";
            prefixPaddingMs: number;
            silenceDurationMs: number;
        };
    };
    sessionResumption: {
        handle?: string;
    };
    contextWindowCompression: {
        triggerTokens: number;
        slidingWindow: {
            targetTokens: number;
        };
    };
};

/**
 * Owns the Gemini Live WebSocket lifecycle, including setup, session
 * resumption and reconnects. Domain-specific handling of Gemini responses is
 * delegated to the bridge through `onMessage`.
 */
export class GeminiLiveConnection {
    private static unsupportedResponseModalitySets = new Set<string>();

    private ws: WebSocket | null = null;
    private setupComplete = false;
    private isReconnecting = false;
    private resumptionHandle: string | null = null;
    private isStopped = false;
    private responseModalities: string[] = ["AUDIO"];
    private readonly log;

    private readonly options: GeminiLiveConnectionOptions;

    constructor(options: GeminiLiveConnectionOptions) {
        this.options = options;
        this.log = createLogger({
            component: "gemini-live-connection",
            targetLanguage: options.targetLanguage,
        });
    }

    async connect(): Promise<void> {
        this.isStopped = false;

        const attempts = this.getResponseModalityAttempts();
        let lastError: unknown;

        for (let index = 0; index < attempts.length; index++) {
            const modalities = attempts[index];
            const nextModalities = attempts[index + 1];
            if (!modalities) {
                continue;
            }
            this.responseModalities = modalities;

            try {
                await this.connectOnce();
                return;
            } catch (error) {
                lastError = error;

                if (
                    this.isStopped ||
                    index === attempts.length - 1 ||
                    !this.shouldRetryWithNextResponseModality(error)
                ) {
                    throw error;
                }

                GeminiLiveConnection.unsupportedResponseModalitySets.add(
                    this.getResponseModalityKey(modalities),
                );
                this.setupComplete = false;
                this.ws = null;

                this.log.warn(
                    {
                        responseModalities: modalities,
                        retryResponseModalities: nextModalities ?? [],
                    },
                    "Gemini rejected setup; retrying with fallback response modalities",
                );
            }
        }

        throw lastError instanceof Error ? lastError : new Error("Gemini setup failed");
    }

    private connectOnce(): Promise<void> {
        this.setupComplete = false;

        return new Promise<void>((resolve, reject) => {
            const ws = this.createWebSocket();
            this.ws = ws;
            let settled = false;
            const finish = (callback: () => void) => {
                if (settled) return;
                settled = true;
                clearInterval(checkSetup);
                clearTimeout(setupTimeout);
                callback();
            };

            ws.on("open", () => {
                this.log.info("Gemini WebSocket connected");
                this.sendSetup(ws);
            });

            ws.on("message", (data: WebSocket.Data) => {
                this.handleInitialMessage(data, () => finish(resolve));
            });

            ws.on("error", (error) => {
                this.log.error({ err: error }, "Gemini WebSocket error");
                if (!this.setupComplete) {
                    finish(() => reject(error));
                }
            });

            ws.on("close", (code: number, reason: Buffer) => {
                const reasonString = reason.toString();
                this.log.info({ code, reason: reasonString }, "Gemini WebSocket closed");
                if (!this.setupComplete) {
                    finish(() =>
                        reject(
                            new Error(
                                `Gemini WebSocket closed before setup: code=${code} reason=${reasonString}`,
                            ),
                        ),
                    );
                } else if (this.canReconnect()) {
                    this.log.info("Reconnecting Gemini WebSocket");
                    this.setupComplete = false;
                    void this.reconnect();
                }
            });

            const checkSetup = setInterval(() => {
                if (this.setupComplete) {
                    finish(resolve);
                }
            }, 100);

            const setupTimeout = setTimeout(() => {
                if (!this.setupComplete) {
                    finish(() => reject(new Error("Gemini setup timeout")));
                }
            }, 15_000);
        });
    }

    stop(): void {
        this.isStopped = true;
        this.setupComplete = false;
        this.ws?.close();
        this.ws = null;
    }

    get isReady(): boolean {
        return this.ws?.readyState === WebSocket.OPEN && this.setupComplete;
    }

    sendAudio(base64Audio: string, sampleRate: number): boolean {
        if (!this.ws || !this.isReady) {
            return false;
        }

        this.ws.send(
            JSON.stringify({
                realtimeInput: {
                    audio: {
                        mimeType: `audio/pcm;rate=${sampleRate}`,
                        data: base64Audio,
                    },
                },
            }),
        );
        return true;
    }

    private async reconnect(): Promise<void> {
        if (this.isReconnecting) {
            this.log.info("Reconnection already in progress");
            return;
        }
        this.isReconnecting = true;

        try {
            this.log.info(
                { hasResumptionHandle: !!this.resumptionHandle },
                "Reconnecting Gemini WebSocket",
            );
            const nextWs = this.createWebSocket();
            let nextSetupComplete = false;

            nextWs.on("open", () => {
                this.log.info("Gemini reconnect WebSocket opened");
                this.sendSetup(nextWs);
            });

            nextWs.on("message", (data: WebSocket.Data) => {
                try {
                    const message = this.parseMessage(data);
                    if (!nextSetupComplete && message.setupComplete) {
                        this.log.info("Gemini reconnect setup complete");
                        nextSetupComplete = true;
                        this.setupComplete = true;

                        const oldWs = this.ws;
                        this.ws = nextWs;
                        this.isReconnecting = false;

                        if (oldWs) {
                            this.log.info("Gracefully closing old Gemini WebSocket");
                            oldWs.removeAllListeners();
                            oldWs.close();
                        }
                        return;
                    }

                    this.handleServerMessage(message);
                } catch (error) {
                    this.log.error({ err: error }, "Error handling reconnect message");
                }
            });

            nextWs.on("error", (error) => {
                this.log.error({ err: error }, "Gemini reconnect error");
            });

            nextWs.on("close", (code: number, reason: Buffer) => {
                const reasonString = reason.toString();
                this.log.info({ code, reason: reasonString }, "Gemini reconnect WebSocket closed");

                if (!this.canReconnect()) return;

                if (this.ws === nextWs) {
                    this.setupComplete = false;
                    setTimeout(() => void this.reconnect(), 1000);
                } else {
                    this.isReconnecting = false;
                    setTimeout(() => void this.reconnect(), 2000);
                }
            });
        } catch (error) {
            this.log.error({ err: error }, "Gemini reconnect initialization failed");
            this.isReconnecting = false;
            if (this.canReconnect()) {
                setTimeout(() => void this.reconnect(), 5000);
            }
        }
    }

    private handleInitialMessage(data: WebSocket.Data, onSetupComplete: () => void): void {
        try {
            const message = this.parseMessage(data);
            if (!this.setupComplete) {
                this.log.info(
                    { messagePreview: JSON.stringify(message).slice(0, 500) },
                    "Gemini message received before setup",
                );
            }

            if (message.setupComplete) {
                this.log.info("Gemini setup complete");
                this.setupComplete = true;
                onSetupComplete();
                return;
            }

            this.handleServerMessage(message);
        } catch (error) {
            this.log.error({ err: error }, "Error parsing Gemini message");
        }
    }

    private handleServerMessage(message: GeminiServerMessage): void {
        const update = message.sessionResumptionUpdate;
        if (update?.resumable && update.newHandle) {
            this.resumptionHandle = update.newHandle;
            this.log.info("Received Gemini session resumption update");
        }

        if (message.goAway) {
            this.log.info(
                { timeLeft: message.goAway.timeLeft ?? "unknown" },
                "Received Gemini goAway message; initiating graceful session resumption",
            );
            void this.reconnect();
        }

        this.options.onMessage(message);
    }

    private sendSetup(ws: WebSocket): void {
        const setup: GeminiSetup = {
            model: `models/${this.options.model}`,
            generationConfig: {
                responseModalities: this.responseModalities,
                translationConfig: {
                    targetLanguageCode: this.options.targetLanguage,
                    echoTargetLanguage: true,
                },
            },
            realtimeInputConfig: {
                automaticActivityDetection: {
                    disabled: false,
                    startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
                    endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                    prefixPaddingMs: 100,
                    silenceDurationMs: 500,
                },
            },
            sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
            contextWindowCompression: {
                triggerTokens: this.options.contextCompressionTriggerTokens,
                slidingWindow: {
                    targetTokens: this.options.contextCompressionTargetTokens,
                },
            },
        };

        // The raw v1beta WebSocket schema accepts audio transcription config on
        // the setup root, not inside generationConfig.
        if (this.options.enableTranscription) {
            setup.outputAudioTranscription = {};
        }

        const setupMessage = { setup };
        this.log.info(
            { resuming: !!this.resumptionHandle, setup: setupMessage },
            "Sending Gemini setup",
        );
        ws.send(JSON.stringify(setupMessage));
    }

    private createWebSocket(): WebSocket {
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.options.apiKey}`;
        return this.options.webSocketFactory?.(url) ?? new WebSocket(url);
    }

    private parseMessage(data: WebSocket.Data): GeminiServerMessage {
        const text =
            typeof data === "string"
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data).toString()
                  : Buffer.isBuffer(data)
                    ? data.toString()
                    : Buffer.from(data).toString();

        const message: unknown = JSON.parse(text);
        return message as GeminiServerMessage;
    }

    private canReconnect(): boolean {
        return !this.isStopped && this.options.shouldReconnect();
    }

    private getResponseModalityAttempts(): string[][] {
        if (!this.options.enableTranscription) {
            return [["AUDIO"]];
        }

        const preferredAttempts = this.options.enableAudioTranslation
            ? [["AUDIO", "TEXT"], ["AUDIO"]]
            : [["TEXT"], ["AUDIO", "TEXT"], ["AUDIO"]];

        const attempts = preferredAttempts.filter(
            (modalities) =>
                !GeminiLiveConnection.unsupportedResponseModalitySets.has(
                    this.getResponseModalityKey(modalities),
                ),
        );

        return attempts.length > 0 ? attempts : [["AUDIO"]];
    }

    private getResponseModalityKey(modalities: string[]): string {
        return modalities.join(",");
    }

    private shouldRetryWithNextResponseModality(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);

        return /code=1007|invalid json|responsemodalit|modality|unsupported|text/i.test(message);
    }
}
