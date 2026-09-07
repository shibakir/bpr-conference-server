import { describe, expect, it } from "vitest";

import { PcmPacketizer } from "../pcm-packetizer";

describe("PcmPacketizer", () => {
    it("preserves every sample across live frame-size changes", () => {
        const packetizer = new PcmPacketizer(100);
        const source = Buffer.alloc(16_000 * 2);
        for (let i = 0; i < source.length / 2; i++) source.writeInt16LE(i, i * 2);
        const packets: Buffer[] = [];
        for (let offset = 0; offset < source.length; offset += 640) {
            if (offset === 640 * 3) packetizer.setFrameSize(50);
            if (offset === 640 * 13) packetizer.setFrameSize(200);
            if (offset === 640 * 20) packetizer.setFrameSize(300);
            if (offset === 640 * 31) packetizer.setFrameSize(50);
            packetizer.push(source.subarray(offset, offset + 640), offset / 32, (packet) =>
                packets.push(Buffer.from(packet)),
            );
            expect(packetizer.pendingDurationMs).toBeLessThan(300);
        }
        expect(Buffer.concat(packets)).toEqual(source);
        expect(packetizer.pendingDurationMs).toBe(0);
    });

    it("keeps the age of an incomplete packet and discards its tail on a gap", () => {
        const packetizer = new PcmPacketizer(100);
        packetizer.push(Buffer.alloc(640), 10, () => {
            throw new Error("early packet");
        });
        const arrivals: number[] = [];
        packetizer.push(Buffer.alloc(2560), 100, (_, at) => arrivals.push(at));
        expect(arrivals).toEqual([10]);
        packetizer.push(Buffer.alloc(640), 120, () => {});
        expect(packetizer.reset()).toBe(20);
        expect(packetizer.pendingDurationMs).toBe(0);
    });

    it("sends continuous 300 ms packets within the input age budget", () => {
        const packetizer = new PcmPacketizer(300);
        const packets: { bytes: number; age: number }[] = [];
        for (let i = 0; i < 45; i++) {
            const now = i * 20;
            packetizer.push(Buffer.alloc(640), now, (packet, receivedAt) => {
                packets.push({ bytes: packet.length, age: now - receivedAt });
            });
        }
        expect(packets).toEqual(Array.from({ length: 3 }, () => ({ bytes: 9600, age: 280 })));
        expect(packetizer.pendingDurationMs).toBe(0);
    });
});
