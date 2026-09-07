import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
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
    bufferedAmount = 0;
    readonly sent: string[] = [];
    readonly terminate = vi.fn(() => this.close());
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
    afterEach(() => vi.useRealTimers());
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

describe("Gemini connection cancellation", () => {
    afterEach(() => vi.useRealTimers());

    it("cancels pending setup and ignores a late acknowledgement after stop", async () => {
        const socket = new FakeWebSocket();
        const { connection, onMessage } = createConnection([socket]);
        const connecting = connection.connect();
        const rejected = expect(connecting).rejects.toThrow("stopped");
        connection.stop();
        socket.receive({ setupComplete: {} });
        socket.receive({ serverContent: { turnComplete: true } });
        await rejected;
        expect(socket.terminate).toHaveBeenCalledOnce();
        expect(connection.isReady).toBe(false);
        expect(onMessage).not.toHaveBeenCalled();
    });

    it("closes both active and replacement sockets when stopped during GoAway", async () => {
        const first = new FakeWebSocket();
        const next = new FakeWebSocket();
        const { connection, onMessage } = createConnection([first, next]);
        const connecting = connection.connect();
        first.open();
        first.receive({ setupComplete: {} });
        await connecting;
        first.receive({ goAway: {} });
        onMessage.mockClear();
        connection.stop();
        next.open();
        next.receive({ setupComplete: {} });
        next.receive({ serverContent: { turnComplete: true } });
        await Promise.resolve();
        expect(first.close).toHaveBeenCalledOnce();
        expect(next.close).toHaveBeenCalledOnce();
        expect(connection.isReady).toBe(false);
        expect(onMessage).not.toHaveBeenCalled();
    });

    it("times out setup, disposes the candidate and cancels backoff on stop", async () => {
        vi.useFakeTimers();
        const first = new FakeWebSocket();
        const next = new FakeWebSocket();
        const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(next);
        const { connection } = createConnection([], { webSocketFactory: factory });
        const connecting = connection.connect();
        first.open();
        first.receive({ setupComplete: {} });
        await connecting;
        first.receive({ goAway: {} });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(next.terminate).toHaveBeenCalledOnce();
        expect(connection.isReady).toBe(true);
        connection.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(factory).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects messages from retired sockets after a successful handover", async () => {
        const first = new FakeWebSocket();
        const next = new FakeWebSocket();
        const { connection, onMessage } = createConnection([first, next]);
        const connecting = connection.connect();
        first.open();
        first.receive({ setupComplete: {} });
        await connecting;
        first.receive({ goAway: {} });
        next.open();
        next.receive({ setupComplete: {} });
        onMessage.mockClear();
        first.receive({ serverContent: { turnComplete: true } });
        expect(onMessage).not.toHaveBeenCalled();
        next.receive({ serverContent: { turnComplete: true } });
        expect(onMessage).toHaveBeenCalledOnce();
        connection.stop();
    });
});

describe("Gemini input backpressure", () => {
    afterEach(() => vi.useRealTimers());
    it("drops input instead of buffering and restarts fresh after sustained congestion", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const first = new FakeWebSocket();
        const next = new FakeWebSocket();
        const onDiscontinuity = vi.fn();
        const { connection } = createConnection([first, next], { onDiscontinuity });
        const connecting = connection.connect();
        first.open();
        first.receive({ setupComplete: {} });
        await connecting;
        first.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "old" } });
        first.bufferedAmount = 50_000;
        const frame = Buffer.alloc(3200).toString("base64");
        expect(connection.sendAudio(frame, 16_000)).toBe(false);
        expect(first.sent).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1001);
        expect(connection.sendAudio(frame, 16_000)).toBe(false);
        expect(first.terminate).toHaveBeenCalledOnce();
        expect(onDiscontinuity).toHaveBeenCalledOnce();
        expect(connection.getInputDiagnostics().droppedInputMs).toBe(200);
        await vi.advanceTimersByTimeAsync(601);
        next.open();
        expect(parseSentPayload<GeminiSetupPayload>(next, 0).setup.sessionResumption).toEqual({});
        next.receive({ setupComplete: {} });
        expect(connection.sendAudio(frame, 16_000)).toBe(true);
        connection.stop();
    });
});
