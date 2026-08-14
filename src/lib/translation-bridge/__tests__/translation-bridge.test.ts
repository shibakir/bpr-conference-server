import { EventEmitter } from "node:events";

import {
    RoomEvent,
    TrackKind,
    type RemoteParticipant,
    type RemoteTrackPublication,
} from "@livekit/rtc-node";
import { describe, expect, it, vi } from "vitest";

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
