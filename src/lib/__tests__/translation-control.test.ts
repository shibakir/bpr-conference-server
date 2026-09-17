import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranslationApiService } from "../../translation-api.service";
import TranslationSessionManager, { hashOrganizerKey } from "../translation-session-manager";
import { TranslationControlError } from "../translation-control";

const manager = TranslationSessionManager.getInstance();
const ids: string[] = [];
function setup() {
    const id = randomUUID();
    ids.push(id);
    manager.createSession(id, "organizer-test", {
        organizerKeyHash: hashOrganizerKey("owner"),
        enableAudioTranslation: true,
        enableTranscription: true,
    });
    let resolve!: (value: "completed" | "unconfirmed") => void;
    let reject!: (reason: unknown) => void;
    const running = new Promise<"completed" | "unconfirmed">((a, b) => {
        resolve = a;
        reject = b;
    });
    const bridge = {
        status: "active",
        identity: "translator-cs",
        subscriberCount: 2,
        executeAction: vi.fn(() => running),
        publishControl: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
    };
    (manager as unknown as { translations: Map<string, Map<string, unknown>> }).translations.set(
        id,
        new Map([["cs", bridge]]),
    );
    const api = new TranslationApiService();
    return {
        id,
        api,
        bridge,
        resolve,
        reject,
        body: { organizerKey: "owner", requestId: randomUUID() },
    };
}
function status(run: () => unknown) {
    try {
        run();
    } catch (e) {
        if (e instanceof HttpException) return e.getStatus();
        throw e;
    }
    throw new Error("Expected rejection");
}
afterEach(async () => {
    for (const id of ids.splice(0)) await manager.removeAllTranslations(id);
});

describe("owner translation operations", () => {
    it("rejects non-owners, invalid requests, original and inactive languages without executing", () => {
        const { api, id, body, bridge } = setup();
        expect(
            status(() =>
                api.startTranslationAction(id, "cs", "reset", { ...body, organizerKey: "wrong" }),
            ),
        ).toBe(403);
        expect(
            status(() =>
                api.startTranslationAction(id, "cs", "reset", { ...body, requestId: "bad" }),
            ),
        ).toBe(400);
        expect(status(() => api.startTranslationAction(id, "original", "reset", body))).toBe(400);
        expect(status(() => api.startTranslationAction(id, "de", "reset", body))).toBe(409);
        expect(bridge.executeAction).not.toHaveBeenCalled();
    });
    it("shares retries, rejects conflicting commands and changes only this language's history", async () => {
        const { api, id, body, bridge, resolve } = setup();
        const first = api.startTranslationAction(id, "cs", "reset", body);
        expect(api.startTranslationAction(id, "cs", "reset", body)).toEqual(first);
        expect(status(() => api.startTranslationAction(id, "cs", "drain", body))).toBe(409);
        expect(
            status(() =>
                api.startTranslationAction(id, "cs", "reset", { ...body, requestId: randomUUID() }),
            ),
        ).toBe(409);
        expect(bridge.subscriberCount).toBe(2);
        expect(bridge.executeAction).toHaveBeenCalledExactlyOnceWith("reset", 1);
        expect(manager.getTranslationControls(id)["de"]).toBeUndefined();
        resolve("completed");
        await Promise.resolve();
        expect(api.startTranslationAction(id, "cs", "reset", body).operation.state).toBe(
            "completed",
        );
        expect(
            status(() =>
                api.startTranslationAction(id, "cs", "reset", { ...body, requestId: randomUUID() }),
            ),
        ).toBe(429);
    });
    it("persists the reset revision after the bridge disappears and isolates snapshots", async () => {
        const { api, id, body, resolve } = setup();
        api.startTranslationAction(id, "cs", "reset", body);
        resolve("completed");
        await Promise.resolve();
        await manager.removeTranslation(id, "cs");
        expect(manager.getTranslationControls(id)["cs"]?.historyRevision).toBe(1);
        const snapshot = manager.getTranslationControls(id);
        snapshot["cs"]!.historyRevision = 500;
        expect(manager.getTranslationControls(id)["cs"]?.historyRevision).toBe(1);
    });
    it("retains history and distinguishes unconfirmed drain from success", async () => {
        const { api, id, body, resolve } = setup();
        api.startTranslationAction(id, "cs", "drain", body);
        resolve("unconfirmed");
        await Promise.resolve();
        expect(manager.getTranslationControls(id)["cs"]).toMatchObject({
            historyRevision: 0,
            operation: { state: "unconfirmed" },
        });
    });
    it("reports failures and cannot resurrect an ended session", async () => {
        const a = setup();
        a.api.startTranslationAction(a.id, "cs", "drain", a.body);
        a.reject(new TranslationControlError("timeout"));
        await Promise.resolve();
        expect(manager.getTranslationControls(a.id)["cs"]?.operation).toMatchObject({
            state: "failed",
            error: "timeout",
        });
        const b = setup();
        b.api.startTranslationAction(b.id, "cs", "reset", b.body);
        await manager.removeAllTranslations(b.id);
        b.resolve("completed");
        await Promise.resolve();
        expect(manager.getTranslationControls(b.id)).toEqual({});
        expect(b.bridge.publishControl).toHaveBeenCalledTimes(1);
    });
});
