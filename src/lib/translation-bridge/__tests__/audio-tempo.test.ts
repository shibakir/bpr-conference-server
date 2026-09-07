import { beforeAll, describe, expect, it } from "vitest";

import { AudioTempo, prepareAudioTempo } from "../audio-tempo";

function sine(sampleRate: number, seconds: number, frequency: number) {
    return Int16Array.from({ length: sampleRate * seconds }, (_, i) =>
        Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12000),
    );
}

describe("AudioTempo", () => {
    it.each([1.05, 1.1, 1.15])("shortens audio at %s× without raising its frequency", (speed) => {
        const sampleRate = 24000;
        const source = sine(sampleRate, 4, 440);
        const tempo = new AudioTempo(sampleRate);
        const chunks: Int16Array[] = [];
        for (let offset = 0; offset < source.length; offset += 480) {
            chunks.push(tempo.push(source.subarray(offset, offset + 480), speed));
            expect(tempo.pendingDurationMs).toBeLessThan(150);
        }
        chunks.push(tempo.flush());
        const output = Int16Array.from(chunks.flatMap((part) => Array.from(part)));
        expect(Math.abs(output.length - Math.round(source.length / speed))).toBeLessThanOrEqual(1);
        // Measure pitch in the middle of the signal, excluding startup/end transients.
        const middle = output.subarray(sampleRate / 2, output.length - sampleRate / 2);
        let crossings = 0;
        for (let i = 1; i < middle.length; i++)
            if (middle[i - 1]! <= 0 && middle[i]! > 0) crossings++;
        const frequency = (crossings * sampleRate) / middle.length;
        expect(Math.abs(frequency - 440)).toBeLessThan(3);
        expect(tempo.pendingDurationMs).toBe(0);
        expect(tempo.flush()).toHaveLength(0);
    });

    it("clears pending sound on reset and does not leak it into the next stream", () => {
        const tempo = new AudioTempo(24000);
        tempo.push(sine(24000, 0.02, 440), 1.15);
        expect(tempo.pendingDurationMs).toBeGreaterThan(0);
        tempo.clear();
        const silence = tempo.push(new Int16Array(4800), 1.1);
        expect(silence.every((value) => value === 0)).toBe(true);
        expect(tempo.flush().every((value) => value === 0)).toBe(true);
    });
});

beforeAll(() => prepareAudioTempo());
