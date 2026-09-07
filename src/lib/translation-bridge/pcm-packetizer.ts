/** Repackages a continuous 16-bit mono PCM stream without restarting its source. */
export class PcmPacketizer {
    private pending = Buffer.alloc(0);
    private pendingAt = 0;

    constructor(
        private frameSizeMs: number,
        private readonly sampleRate = 16_000,
    ) {}

    setFrameSize(frameSizeMs: number): void {
        this.frameSizeMs = frameSizeMs;
    }

    get pendingDurationMs(): number {
        return (this.pending.length / 2 / this.sampleRate) * 1000;
    }

    reset(): number {
        const droppedMs = this.pendingDurationMs;
        this.pending = Buffer.alloc(0);
        return droppedMs;
    }

    push(pcm: Buffer, receivedAt: number, emit: (pcm: Buffer, receivedAt: number) => void): void {
        if (pcm.length % 2 !== 0) throw new Error("PCM must contain complete 16-bit samples");
        if (!this.pending.length) this.pendingAt = receivedAt;
        let data = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
        const bytes = ((this.sampleRate * this.frameSizeMs) / 1000) * 2;
        while (data.length >= bytes) {
            emit(data.subarray(0, bytes), this.pendingAt);
            data = data.subarray(bytes);
            this.pendingAt = receivedAt;
        }
        // Copy just the tail so a tiny remainder cannot retain an arbitrarily large input buffer.
        this.pending = Buffer.from(data);
    }
}
