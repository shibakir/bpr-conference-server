import { EventEmitter } from "node:events";
import { vi } from "vitest";
import WebSocket from "ws";

export class FakeGeminiSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    bufferedAmount = 0;
    sent: string[] = [];
    callbacks: Array<(error?: Error) => void> = [];
    delayedClose = false;
    terminate = vi.fn(() => {
        this.readyState = WebSocket.CLOSING;
        if (!this.delayedClose) this.finishClose();
    });
    close = vi.fn(() => this.terminate());
    finishClose(): void {
        this.readyState = WebSocket.CLOSED;
        this.emit("close", 1000, Buffer.alloc(0));
    }
    send(data: string, callback?: (error?: Error) => void): void {
        this.sent.push(data);
        if (callback) this.callbacks.push(callback);
    }
    setup(): void {
        this.readyState = WebSocket.OPEN;
        this.emit("open");
        this.receive({ setupComplete: {} });
    }
    receive(message: object): void {
        this.emit("message", Buffer.from(JSON.stringify(message)));
    }
    text(text: string): void {
        this.receive({ serverContent: { outputTranscription: { text } } });
    }
    audioPackets(): unknown[] {
        return this.sent
            .map((line) => JSON.parse(line) as { realtimeInput?: { audio?: unknown } })
            .flatMap((message) =>
                message.realtimeInput?.audio ? [message.realtimeInput.audio] : [],
            );
    }
}

export function socketFactory() {
    const sockets: FakeGeminiSocket[] = [];
    let maxOpen = 0;
    const factory = vi.fn(() => {
        const socket = new FakeGeminiSocket();
        sockets.push(socket);
        maxOpen = Math.max(
            maxOpen,
            sockets.filter((s) => s.readyState !== WebSocket.CLOSED).length,
        );
        return socket as unknown as WebSocket;
    });
    return { sockets, factory, maxOpen: () => maxOpen };
}
