import { prepareAudioTempo } from "../audio-tempo";
import { EventEmitter } from "node:events";

import {
    RoomEvent,
    TrackKind,
    type RemoteParticipant,
    type RemoteTrackPublication,
} from "@livekit/rtc-node";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TranslationBridge } from "../index";

type FakePublication = {
    kind: TrackKind;
    muted: boolean;
    name: string;
    setSubscribed: ReturnType<typeof vi.fn<(subscribed: boolean) => void>>;
    sid: string;
    subscribed: boolean;
};

type BridgeInternals = {
    activeOrganizerAudioPipelineId: string | null;
    room: FakeRoom | null;
    subscribeToOrganizer(): Promise<void>;
};

class FakeRoom extends EventEmitter {
    remoteParticipants = new Map<string, RemoteParticipant>();
}

function createPublication(sid: string): FakePublication {
    const publication: FakePublication = {
        kind: TrackKind.KIND_AUDIO,
        muted: false,
        name: "broadcast-audio",
        setSubscribed: vi.fn((subscribed: boolean) => {
            publication.subscribed = subscribed;
        }),
        sid,
        subscribed: false,
    };

    return publication;
}

function createParticipant(identity: string, publications: FakePublication[]): RemoteParticipant {
    return {
        identity,
        trackPublications: new Map(
            publications.map((publication) => [
                publication.sid,
                publication as unknown as RemoteTrackPublication,
            ]),
        ),
    } as unknown as RemoteParticipant;
}

function createBridge(): TranslationBridge {
    return new TranslationBridge("session-id", "cs", "organizer-host", {
        geminiApiKey: "gemini-key",
        livekitApiKey: "livekit-key",
        livekitApiSecret: "livekit-secret",
        livekitUrl: "ws://livekit.test",
        enableAudioTranslation: true,
        enableTranscription: true,
    });
}

describe("TranslationBridge", () => {
    it("subscribes to organizer audio again after control recovery reconnects the organizer", async () => {
        const bridge = createBridge();
        const bridgeInternals = bridge as unknown as BridgeInternals;
        const room = new FakeRoom();
        const oldPublication = createPublication("old-audio");
        const oldOrganizer = createParticipant("organizer-host", [oldPublication]);
        room.remoteParticipants.set(oldOrganizer.identity, oldOrganizer);
        bridgeInternals.room = room;

        await bridgeInternals.subscribeToOrganizer();

        expect(oldPublication.setSubscribed).toHaveBeenCalledWith(true);

        bridgeInternals.activeOrganizerAudioPipelineId = oldPublication.sid;
        room.remoteParticipants.delete(oldOrganizer.identity);
        room.emit(RoomEvent.ParticipantDisconnected, oldOrganizer);

        expect(bridgeInternals.activeOrganizerAudioPipelineId).toBeNull();

        const newPublication = createPublication("new-audio");
        const newOrganizer = createParticipant("organizer-host", [newPublication]);
        room.remoteParticipants.set(newOrganizer.identity, newOrganizer);
        room.emit(RoomEvent.ParticipantConnected, newOrganizer);

        expect(newPublication.setSubscribed).toHaveBeenCalledWith(true);
    });
});

describe("TranslationBridge lifecycle", () => {
    it("shares concurrent stop, releases every resource and calls onStop once", async () => {
        const bridge = createBridge();
        let finishDisconnect!: () => void;
        const disconnect = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishDisconnect = resolve;
                }),
        );
        const cancel = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn().mockResolvedValue(undefined);
        const stopConnection = vi.fn();
        const internals = bridge as unknown as {
            room: { disconnect: typeof disconnect; removeAllListeners: ReturnType<typeof vi.fn> };
            organizerAudioReader: { cancel: typeof cancel };
            translatedAudioOutput: { close: typeof close };
            geminiConnection: { stop: typeof stopConnection };
        };
        internals.room = { disconnect, removeAllListeners: vi.fn() };
        internals.organizerAudioReader = { cancel };
        internals.translatedAudioOutput = { close };
        internals.geminiConnection = { stop: stopConnection };
        const onStop = vi.fn(() => {
            void bridge.stop();
        });
        bridge.onStop = onStop;
        const first = bridge.stop();
        const second = bridge.stop();
        expect(first).toBe(second);
        expect(bridge.status).toBe("closed");
        await Promise.resolve();
        expect(cancel).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(stopConnection).toHaveBeenCalledOnce();
        finishDisconnect();
        await Promise.all([first, second]);
        expect(onStop).toHaveBeenCalledOnce();
        expect(bridge.onStop).toBeUndefined();
    });

    it("does not resurrect a bridge stopped while startup awaits Gemini", async () => {
        const bridge = createBridge();
        let acknowledge!: () => void;
        const internals = bridge as unknown as {
            joinLiveKitRoom: () => Promise<void>;
            connectGemini: () => Promise<void>;
            subscribeToOrganizer: ReturnType<typeof vi.fn>;
        };
        internals.joinLiveKitRoom = async () => {};
        internals.connectGemini = () =>
            new Promise<void>((resolve) => {
                acknowledge = resolve;
            });
        internals.subscribeToOrganizer = vi.fn();
        const starting = bridge.start();
        const rejected = expect(starting).rejects.toThrow("stopped during startup");
        await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
        await bridge.stop();
        acknowledge();
        await rejected;
        expect(bridge.status).toBe("closed");
        expect(internals.subscribeToOrganizer).not.toHaveBeenCalled();
    });
});

beforeAll(() => prepareAudioTempo());
