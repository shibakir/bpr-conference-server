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
    systemInstruction?: string;
    shouldReconnect: () => boolean;
    onMessage: (message: GeminiServerMessage) => void;
    webSocketFactory?: (url: string) => WebSocket;
    onDiscontinuity?: () => void;
};

type GeminiSetup = {
    model: string;
    systemInstruction?: {
        parts: Array<{
            text: string;
        }>;
    };
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
    private pendingSocket: WebSocket | null = null;
    private cancelPending: (() => void) | null = null;
    private retryTimer: NodeJS.Timeout | null = null;
    private retryAttempt = 0;
    private congestionSince: number | null = null;
    private firstUnansweredVoiceAt: number | null = null;
    private lastVoicedAt: number | null = null;
    private unansweredVoiceMs = 0;
    private freshRestarts: number[] = [];
    private droppedInputMs = 0;
    private resetCount = 0;
    private setupComplete = false;
    private resumptionHandle: string | null = null;
    private isStopped = false;
    private responseModalities: string[] = ["AUDIO"];
    private readonly log;

    constructor(private readonly options: GeminiLiveConnectionOptions) {
        this.log = createLogger({
            component: "gemini-live-connection",
            targetLanguage: options.targetLanguage,
        });
    }

    async connect(): Promise<void> {
        if (this.isStopped) throw new Error("Gemini connection stopped");
        const attempts = this.getResponseModalityAttempts();
        for (let index = 0; index < attempts.length; index++) {
            const modalities = attempts[index];
            if (!modalities) continue;
            this.responseModalities = modalities;
            try {
                await this.connectOnce();
                return;
            } catch (error) {
                if (
                    this.isStopped ||
                    index === attempts.length - 1 ||
                    !this.shouldRetryWithNextResponseModality(error)
                )
                    throw error;
                GeminiLiveConnection.unsupportedResponseModalitySets.add(
                    this.getResponseModalityKey(modalities),
                );
                this.log.warn(
                    { responseModalities: modalities },
                    "Gemini rejected setup; retrying fallback response modalities",
                );
            }
        }
        throw new Error("Gemini setup failed");
    }

    private connectOnce(): Promise<void> {
        if (this.isStopped) return Promise.reject(new Error("Gemini connection stopped"));
        return new Promise<void>((resolve, reject) => {
            const socket = this.createWebSocket();
            this.pendingSocket = socket;
            let acknowledged = false;
            let settled = false;
            const timeout = setTimeout(() => fail(new Error("Gemini setup timeout")), 15_000);
            const settle = () => {
                settled = true;
                clearTimeout(timeout);
                if (this.pendingSocket === socket) {
                    this.pendingSocket = null;
                    this.cancelPending = null;
                }
            };
            const fail = (error: Error) => {
                if (settled) return;
                settle();
                this.retireSocket(socket);
                reject(error);
            };
            this.cancelPending = () => fail(new Error("Gemini connection stopped"));
            const isCurrent = () =>
                !this.isStopped && (this.pendingSocket === socket || this.ws === socket);

            socket.on("open", () => {
                if (!isCurrent()) return;
                try {
                    this.sendSetup(socket);
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            });
            socket.on("message", (data: WebSocket.Data) => {
                if (!isCurrent()) return;
                try {
                    const message = this.parseMessage(data);
                    if (!acknowledged && message.setupComplete) {
                        acknowledged = true;
                        const old = this.ws;
                        this.ws = socket;
                        this.setupComplete = true;
                        this.retryAttempt = 0;
                        settle();
                        if (old && old !== socket) this.retireSocket(old);
                        resolve();
                        return;
                    }
                    // Candidate/retired sockets must never publish translated output.
                    if (acknowledged && this.ws === socket) this.handleServerMessage(message);
                } catch (error) {
                    this.log.error({ err: error }, "Error parsing Gemini message");
                }
            });
            socket.on("error", (error: Error) => {
                if (!isCurrent()) return;
                if (!acknowledged) fail(error);
                else {
                    this.ws = null;
                    this.setupComplete = false;
                    this.retireSocket(socket);
                    this.scheduleReconnect();
                }
            });
            socket.on("close", (code: number, reason: Buffer) => {
                if (!isCurrent()) return;
                if (!acknowledged) {
                    fail(
                        new Error(
                            `Gemini WebSocket closed before setup: code=${code} reason=${reason.toString()}`,
                        ),
                    );
                } else if (this.ws === socket) {
                    this.ws = null;
                    this.setupComplete = false;
                    this.scheduleReconnect();
                }
            });
        });
    }

    stop(): void {
        if (this.isStopped) return;
        this.isStopped = true;
        this.setupComplete = false;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.cancelPending?.();
        const socket = this.ws;
        this.ws = null;
        if (socket) this.retireSocket(socket);
    }

    get isReady(): boolean {
        return !this.isStopped && this.ws?.readyState === WebSocket.OPEN && this.setupComplete;
    }

    get isRecovering(): boolean {
        return (
            !this.isStopped &&
            (!!this.pendingSocket ||
                !!this.retryTimer ||
                this.congestionSince !== null ||
                !this.isReady)
        );
    }

    getInputDiagnostics() {
        return {
            droppedInputMs: Math.round(this.droppedInputMs),
            bufferedBytes: this.ws?.bufferedAmount ?? 0,
            resets: this.resetCount,
            recovering: this.isRecovering,
        };
    }

    recordDroppedInput(durationMs: number): void {
        this.droppedInputMs += Math.max(0, durationMs);
    }

    /** Drop at the input boundary instead of building a second unbounded queue in ws. */
    sendAudio(base64Audio: string, sampleRate: number): boolean {
        const pcm = Buffer.from(base64Audio, "base64");
        const durationMs = (pcm.length / 2 / sampleRate) * 1000;
        if (!this.ws || !this.isReady) {
            this.recordDroppedInput(durationMs);
            return false;
        }
        const payload = JSON.stringify({
            realtimeInput: {
                audio: {
                    mimeType: `audio/pcm;rate=${sampleRate}`,
                    data: base64Audio,
                },
            },
        });
        // About 500ms of PCM including base64 plus JSON overhead, never a guessed PCM duration.
        const maxBufferedBytes = Math.ceil((sampleRate * 2 * 0.5 * 4) / 3) + 2048;
        if (this.ws.bufferedAmount + Buffer.byteLength(payload) > maxBufferedBytes) {
            this.recordDroppedInput(durationMs);
            this.congestionSince ??= performance.now();
            if (performance.now() - this.congestionSince >= 1000) this.restartFresh();
            return false;
        }
        this.congestionSince = null;
        const socket = this.ws;
        try {
            socket.send(payload, (error?: Error) => {
                // A late callback from a retired socket must not tear down its replacement.
                if (error && this.ws === socket && !this.isStopped) this.restartFresh("send-error");
            });
        } catch {
            this.recordDroppedInput(durationMs);
            this.restartFresh("send-error");
            return false;
        }
        this.observeVoice(pcm, durationMs);
        return true;
    }

    restartFresh(reason = "transport-congestion"): void {
        if (!this.canReconnect()) return;
        const now = performance.now();
        this.freshRestarts = this.freshRestarts.filter((time) => now - time < 300_000);
        if (
            this.freshRestarts.length >= 3 ||
            now - (this.freshRestarts.at(-1) ?? -Infinity) < 60_000
        )
            return;
        this.freshRestarts.push(now);
        this.log.warn({ reason }, "Restarting Gemini with fresh context");
        this.resetVoiceWatchdog();
        this.resumptionHandle = null;
        this.congestionSince = null;
        this.resetCount++;
        this.cancelPending?.();
        const socket = this.ws;
        this.ws = null;
        this.setupComplete = false;
        // terminate discards pending network writes; close would try to flush stale audio first.
        if (socket) {
            socket.removeAllListeners();
            socket.on("error", () => {});
            socket.terminate();
        }
        this.options.onDiscontinuity?.();
        this.scheduleReconnect();
    }

    private resetVoiceWatchdog(): void {
        this.firstUnansweredVoiceAt = null;
        this.lastVoicedAt = null;
        this.unansweredVoiceMs = 0;
    }

    private observeVoice(pcm: Buffer, durationMs: number): void {
        let energy = 0;
        for (let i = 0; i + 1 < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
        if (Math.sqrt(energy / Math.max(1, pcm.length / 2)) < 400) return;
        const now = performance.now();
        // Long pauses start a new observation window. Silence alone never triggers recovery.
        if (this.lastVoicedAt !== null && now - this.lastVoicedAt > 2000) this.resetVoiceWatchdog();
        this.firstUnansweredVoiceAt ??= now;
        this.lastVoicedAt = now;
        this.unansweredVoiceMs += durationMs;
        if (now - this.firstUnansweredVoiceAt >= 30_000 && this.unansweredVoiceMs >= 15_000)
            this.restartFresh("unanswered-voiced-input");
    }

    private retireSocket(socket: WebSocket): void {
        socket.removeAllListeners();
        // Closing a CONNECTING ws emits an asynchronous error in the ws library.
        socket.on("error", () => {});
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else if (socket.readyState !== WebSocket.CLOSED) socket.close();
    }

    private scheduleReconnect(): void {
        if (!this.canReconnect() || this.pendingSocket || this.retryTimer) return;
        const baseMs = Math.min(500 * 2 ** Math.min(this.retryAttempt++, 6), 30_000);
        const delayMs = Math.round(baseMs * (1 + Math.random() * 0.2));
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.reconnect();
        }, delayMs);
    }

    private reconnect(): void {
        if (!this.canReconnect() || this.pendingSocket || this.retryTimer) return;
        void this.connectOnce().catch((error) => {
            if (!this.canReconnect()) return;
            this.log.warn({ err: error }, "Gemini reconnect failed");
            this.scheduleReconnect();
        });
    }

    private handleServerMessage(message: GeminiServerMessage): void {
        if (
            message.outputTranscription?.text ||
            message.serverContent?.outputTranscription?.text ||
            message.serverContent?.modelTurn?.parts?.some(
                (part) => part.text || part.inlineData?.data,
            )
        )
            this.resetVoiceWatchdog();
        const update = message.sessionResumptionUpdate;
        if (update?.resumable && update.newHandle) this.resumptionHandle = update.newHandle;
        if (message.goAway) this.reconnect();
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

        if (this.options.systemInstruction) {
            setup.systemInstruction = {
                parts: [{ text: this.options.systemInstruction }],
            };
        }

        // The raw v1beta WebSocket schema accepts audio transcription config on
        // the setup root, not inside generationConfig.
        if (this.options.enableTranscription) {
            setup.outputAudioTranscription = {};
        }

        const setupMessage = { setup };
        const loggedSetupMessage = this.options.systemInstruction
            ? {
                  setup: {
                      ...setup,
                      systemInstruction: {
                          parts: [
                              {
                                  text: `[redacted length=${this.options.systemInstruction.length}]`,
                              },
                          ],
                      },
                  },
              }
            : setupMessage;
        this.log.info(
            { resuming: !!this.resumptionHandle, setup: loggedSetupMessage },
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
