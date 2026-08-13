import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { parseJson } from "../../api-request";
import { GeminiLiveConnection, type GeminiLiveConnectionOptions } from "../gemini-live-connection";

type GeminiSetupPayload = {
    setup: {
        generationConfig: {
            outputAudioTranscription?: unknown;
            responseModalities: string[];
        };
        model: string;
        outputAudioTranscription?: unknown;
        sessionResumption?: unknown;
    };
};

class FakeWebSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    readonly sent: string[] = [];
    readonly close = vi.fn(() => {
        this.readyState = WebSocket.CLOSED;
        this.emit("close", 1000, Buffer.alloc(0));
    });

    send(payload: string): void {
        this.sent.push(payload);
    }

    open(): void {
        this.readyState = WebSocket.OPEN;
        this.emit("open");
    }

    receive(message: object): void {
        this.emit("message", Buffer.from(JSON.stringify(message)));
    }
}

function createConnection(
    sockets: FakeWebSocket[],
    options: Partial<GeminiLiveConnectionOptions> = {},
) {
    let nextSocket = 0;
    const onMessage = vi.fn();
    const connection = new GeminiLiveConnection({
        apiKey: "test-key",
        model: "gemini-test-model",
        targetLanguage: "cs",
        enableAudioTranslation: true,
        enableTranscription: true,
        contextCompressionTriggerTokens: 25_000,
        contextCompressionTargetTokens: 8_000,
        shouldReconnect: () => true,
        onMessage,
        webSocketFactory: () => sockets[nextSocket++] as unknown as WebSocket,
        ...options,
    });

    return { connection, onMessage };
}

function parseSentPayload<T>(socket: FakeWebSocket, index: number): T {
    const payload = socket.sent[index];
    if (payload === undefined) {
        throw new Error(`Expected sent WebSocket payload at index ${index}`);
    }

    return parseJson(payload) as T;
}

describe("GeminiLiveConnection", () => {
    it("waits for setupComplete before allowing audio and sends the expected setup", async () => {
        const socket = new FakeWebSocket();
        const { connection } = createConnection([socket]);

        const connecting = connection.connect();
        socket.open();

        const setupPayload = parseSentPayload<GeminiSetupPayload>(socket, 0);
        expect(setupPayload.setup.model).toBe("models/gemini-test-model");
        expect(setupPayload.setup.outputAudioTranscription).toEqual({});
        expect(setupPayload.setup.generationConfig.responseModalities).toEqual(["AUDIO", "TEXT"]);
        expect(setupPayload.setup.generationConfig.outputAudioTranscription).toBeUndefined();
        expect(connection.sendAudio("AQI=", 16_000)).toBe(false);

        socket.receive({ setupComplete: {} });
        await connecting;

        expect(connection.isReady).toBe(true);
        expect(connection.sendAudio("AQI=", 16_000)).toBe(true);
        expect(parseSentPayload(socket, 1)).toEqual({
            realtimeInput: {
                audio: {
                    mimeType: "audio/pcm;rate=16000",
                    data: "AQI=",
                },
            },
        });
    });

    it("resumes a session after GoAway and retires the old socket", async () => {
        const firstSocket = new FakeWebSocket();
        const secondSocket = new FakeWebSocket();
        const { connection } = createConnection([firstSocket, secondSocket]);

        const connecting = connection.connect();
        firstSocket.open();
        firstSocket.receive({ setupComplete: {} });
        await connecting;

        firstSocket.receive({
            sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
        });
        firstSocket.receive({ goAway: { timeLeft: "10s" } });

        secondSocket.open();
        expect(
            parseSentPayload<GeminiSetupPayload>(secondSocket, 0).setup.sessionResumption,
        ).toEqual({ handle: "resume-1" });
        secondSocket.receive({ setupComplete: {} });

        expect(connection.isReady).toBe(true);
        expect(firstSocket.close).toHaveBeenCalledOnce();
    });

    it("does not reconnect after an explicit stop", async () => {
        const socket = new FakeWebSocket();
        const { connection } = createConnection([socket]);

        const connecting = connection.connect();
        socket.open();
        socket.receive({ setupComplete: {} });
        await connecting;

        connection.stop();

        expect(socket.close).toHaveBeenCalledOnce();
        expect(connection.isReady).toBe(false);
    });

    it("uses audio-only response modality when text outputs are disabled", async () => {
        const socket = new FakeWebSocket();
        const { connection } = createConnection([socket], {
            enableTranscription: false,
        });

        const connecting = connection.connect();
        socket.open();

        const setupPayload = parseSentPayload<GeminiSetupPayload>(socket, 0);
        expect(setupPayload.setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
        expect(setupPayload.setup.outputAudioTranscription).toBeUndefined();

        socket.receive({ setupComplete: {} });
        await connecting;
    });

    it("tries text-only first for text-only sessions", async () => {
        const socket = new FakeWebSocket();
        const { connection } = createConnection([socket], {
            enableAudioTranslation: false,
        });

        const connecting = connection.connect();
        socket.open();

        expect(
            parseSentPayload<GeminiSetupPayload>(socket, 0).setup.generationConfig
                .responseModalities,
        ).toEqual(["TEXT"]);

        socket.receive({ setupComplete: {} });
        await connecting;
    });

    it("falls back to audio-only response modality when Gemini rejects text modality setup", async () => {
        const firstSocket = new FakeWebSocket();
        const secondSocket = new FakeWebSocket();
        const { connection } = createConnection([firstSocket, secondSocket]);

        const connecting = connection.connect();
        firstSocket.open();
        firstSocket.emit(
            "close",
            1007,
            Buffer.from("Invalid JSON payload received. Unsupported modality TEXT."),
        );

        await new Promise((resolve) => setImmediate(resolve));
        secondSocket.open();

        expect(
            parseSentPayload<GeminiSetupPayload>(secondSocket, 0).setup.generationConfig
                .responseModalities,
        ).toEqual(["AUDIO"]);

        secondSocket.receive({ setupComplete: {} });
        await connecting;
        expect(connection.isReady).toBe(true);
    });
});
