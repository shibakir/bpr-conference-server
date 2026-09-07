type SoundTouchModule = typeof import("@soundtouchjs/core", {
    with: { "resolution-mode": "import" },
});
let core: SoundTouchModule | undefined;
let loading: Promise<void> | undefined;

/** Native dynamic import also works in the CommonJS Nest/tsx development runtime. */
export function prepareAudioTempo(): Promise<void> {
    return (loading ??= import("@soundtouchjs/core").then((module) => {
        core = module;
    }));
}

/** Streaming WSOLA time stretch; sample rate and pitch remain unchanged. */
export class AudioTempo {
    private readonly stretch: InstanceType<SoundTouchModule["Stretch"]>;
    private expectedFrames = 0;
    private emittedFrames = 0;

    constructor(private readonly sampleRate: number) {
        if (!core) throw new Error("Audio tempo processor has not been initialized");
        const { Stretch, FifoSampleBuffer } = core;
        this.stretch = new Stretch({
            sampleRate,
            createBuffers: true,
            sampleBufferFactory: () => new FifoSampleBuffer(sampleRate),
        });
        this.stretch.setStretchParameters({ sequenceMs: 40, seekWindowMs: 12, overlapMs: 8 });
    }

    get pendingDurationMs(): number {
        return (Math.max(0, this.expectedFrames - this.emittedFrames) / this.sampleRate) * 1000;
    }

    push(pcm: Int16Array, speed: number): Int16Array {
        this.stretch.tempo = Math.min(1.15, Math.max(1, speed));
        this.expectedFrames += pcm.length / this.stretch.tempo;
        const stereo = new Float32Array(pcm.length * 2);
        for (let i = 0; i < pcm.length; i++) stereo[i * 2] = stereo[i * 2 + 1] = pcm[i]! / 32768;
        this.stretch.inputBuffer!.putSamples(stereo);
        this.stretch.process();
        return this.take();
    }

    flush(): Int16Array {
        if (this.pendingDurationMs <= 0) return new Int16Array(0);
        // Padding only releases the held lookahead. It is excluded from expectedFrames.
        this.stretch.inputBuffer!.putSamples(new Float32Array(this.stretch.sampleReq * 4));
        this.stretch.process();
        const tail = this.take();
        this.clear();
        return tail;
    }

    clear(): void {
        this.stretch.clear();
        this.expectedFrames = 0;
        this.emittedFrames = 0;
    }

    private take(): Int16Array {
        const output = this.stretch.outputBuffer!;
        const count = Math.min(
            output.frameCount,
            Math.max(0, Math.round(this.expectedFrames) - this.emittedFrames),
        );
        const stereo = new Float32Array(count * 2);
        output.extract(stereo, 0, count);
        output.receive(count);
        this.emittedFrames += count;
        const mono = new Int16Array(count);
        for (let i = 0; i < count; i++)
            mono[i] = Math.max(-32768, Math.min(32767, Math.round(stereo[i * 2]! * 32768)));
        return mono;
    }
}
