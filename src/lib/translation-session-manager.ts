/**
 * TranslationSessionManager: Singleton that enforces "max 1 Gemini Live API
 * session per language per room" constraint.
 *
 * Usage:
 *   const manager = TranslationSessionManager.getInstance();
 *   const bridge = await manager.getOrCreate(sessionId, targetLanguage, organizerIdentity);
 */

import { type ParticipantInfo, RoomServiceClient } from "livekit-server-sdk";

import { createLogger } from "./logger";
import {
    getGeminiApiKey,
    getLiveKitCredentials,
    getLiveKitUrl,
    getPositiveNumberEnv,
} from "./server-env";
import { DEFAULT_SESSION_DURATION_MINUTES } from "./session-duration";
import { type BridgeStatus, TranslationBridge } from "./translation-bridge";
import { participantWantsTranslation } from "./translation-bridge/participant-attributes";

export interface TranslationInfo {
    language: string;
    translatorIdentity: string;
    status: BridgeStatus;
    subscriberCount: number;
}

export interface SessionInfo {
    sessionId: string;
    organizerIdentity: string;
    createdAt: Date;
    durationMinutes: number;
    expiresAt: Date;
    enableAudioTranslation: boolean;
    enableTranscription: boolean;
    allowedLanguages?: string[];
}

const globalForSessionManager = global as unknown as {
    sessionManagerInstance: TranslationSessionManager;
};

const log = createLogger({ component: "translation-session-manager" });

function getLiveKitApiUrl(): string {
    const configuredUrl = getLiveKitUrl();

    if (configuredUrl.startsWith("wss://")) {
        return `https://${configuredUrl.slice("wss://".length)}`;
    }

    if (configuredUrl.startsWith("ws://")) {
        return `http://${configuredUrl.slice("ws://".length)}`;
    }

    if (!/^https?:\/\//.test(configuredUrl)) {
        return `http://${configuredUrl}`;
    }

    return configuredUrl;
}

class TranslationSessionManager {
    // Map<sessionId, Map<languageCode, TranslationBridge>>
    private translations: Map<string, Map<string, TranslationBridge>> = new Map();

    // Map<sessionId, SessionInfo>
    private sessions: Map<string, SessionInfo> = new Map();

    private sessionExpirationTimers: Map<string, NodeJS.Timeout> = new Map();
    private roomServiceClient: RoomServiceClient | null = null;
    private reconcileInterval: NodeJS.Timeout | null = null;
    private reconcileInFlight: Promise<void> | null = null;
    private bridgeLastSubscriberSeenAt: WeakMap<TranslationBridge, number> = new WeakMap();
    private readonly reconcileIntervalMs = getPositiveNumberEnv(
        "TRANSLATION_RECONCILE_INTERVAL_MS",
        30_000,
    );
    private readonly emptyBridgeGraceMs = getPositiveNumberEnv(
        "TRANSLATION_EMPTY_BRIDGE_GRACE_MS",
        60_000,
    );

    private constructor() {}

    static getInstance(): TranslationSessionManager {
        if (!globalForSessionManager.sessionManagerInstance) {
            globalForSessionManager.sessionManagerInstance = new TranslationSessionManager();
        }
        return globalForSessionManager.sessionManagerInstance;
    }

    // Session management
    createSession(
        sessionId: string,
        organizerIdentity: string,
        options: {
            enableAudioTranslation: boolean;
            enableTranscription: boolean;
            allowedLanguages?: string[];
            durationMinutes?: number;
        },
    ): SessionInfo {
        const createdAt = new Date();
        const durationMinutes = options.durationMinutes ?? DEFAULT_SESSION_DURATION_MINUTES;
        const info: SessionInfo = {
            sessionId,
            organizerIdentity,
            createdAt,
            durationMinutes,
            expiresAt: new Date(createdAt.getTime() + durationMinutes * 60_000),
            enableAudioTranslation: options.enableAudioTranslation,
            enableTranscription: options.enableTranscription,
            ...(options.allowedLanguages ? { allowedLanguages: options.allowedLanguages } : {}),
        };
        this.sessions.set(sessionId, info);
        this.scheduleSessionExpiration(info);
        log.info(
            {
                allowedLanguages: options.allowedLanguages ?? "all",
                durationMinutes,
                enableAudioTranslation: options.enableAudioTranslation,
                enableTranscription: options.enableTranscription,
                organizerIdentity,
                sessionId,
            },
            "Created session",
        );
        return info;
    }

    getSession(sessionId: string): SessionInfo | undefined {
        const session = this.sessions.get(sessionId);
        if (!session) return undefined;

        if (this.hasSessionExpired(session)) {
            void this.expireSession(sessionId, session.expiresAt.getTime());
            return undefined;
        }

        return session;
    }

    hasSession(sessionId: string): boolean {
        return this.sessions.has(sessionId) || this.translations.has(sessionId);
    }

    // Translation management
    async getOrCreate(
        sessionId: string,
        targetLanguage: string,
        organizerIdentity: string,
        options: {
            enableAudioTranslation?: boolean;
            enableTranscription?: boolean;
        } = {},
    ): Promise<TranslationBridge> {
        const session = this.getSession(sessionId);
        if (!session) {
            throw new Error("Session has ended");
        }

        // Check if we already have a bridge for this language
        let languageMap = this.translations.get(sessionId);
        if (languageMap) {
            const existingBridge = languageMap.get(targetLanguage);
            if (existingBridge && existingBridge.status === "active") {
                log.info({ sessionId, targetLanguage }, "Reusing existing translation bridge");
                existingBridge.subscriberCount++;
                this.bridgeLastSubscriberSeenAt.set(existingBridge, Date.now());
                this.ensureReconcileTimer();
                return existingBridge;
            }
            // If bridge exists but is in error/closed state, clean it up
            if (
                existingBridge &&
                (existingBridge.status === "error" || existingBridge.status === "closed")
            ) {
                log.info(
                    { sessionId, status: existingBridge.status, targetLanguage },
                    "Cleaning up stale translation bridge",
                );
                await existingBridge.stop();
                this.cleanupBridgeReference(sessionId, targetLanguage, existingBridge);
                languageMap = this.translations.get(sessionId);
            }
        }

        // Create a new bridge
        log.info({ sessionId, targetLanguage }, "Creating new translation bridge");

        const geminiApiKey = getGeminiApiKey();
        const liveKitCredentials = getLiveKitCredentials();

        if (!geminiApiKey || !liveKitCredentials) {
            throw new Error("Translation service credentials are not configured");
        }

        const config = {
            geminiApiKey,
            livekitUrl: getLiveKitUrl(),
            livekitApiKey: liveKitCredentials.apiKey,
            livekitApiSecret: liveKitCredentials.apiSecret,
            enableAudioTranslation: options.enableAudioTranslation !== false,
            enableTranscription: options.enableTranscription === true,
        };

        const bridge = new TranslationBridge(sessionId, targetLanguage, organizerIdentity, config);

        bridge.onStop = () => {
            this.cleanupBridgeReference(sessionId, targetLanguage, bridge);
        };

        // Store the bridge before starting (to prevent race conditions)
        if (!languageMap) {
            languageMap = new Map();
            this.translations.set(sessionId, languageMap);
        }
        languageMap.set(targetLanguage, bridge);
        this.bridgeLastSubscriberSeenAt.set(bridge, Date.now());
        this.ensureReconcileTimer();

        try {
            await bridge.start();
            bridge.subscriberCount = 1;
            return bridge;
        } catch (error) {
            // Clean up on failure
            this.cleanupBridgeReference(sessionId, targetLanguage, bridge);
            throw error;
        }
    }

    getActiveTranslations(sessionId: string): TranslationInfo[] {
        if (!this.getSession(sessionId)) return [];

        const languageMap = this.translations.get(sessionId);
        if (!languageMap) return [];

        const result: TranslationInfo[] = [];
        for (const [language, bridge] of languageMap) {
            result.push({
                language,
                translatorIdentity: bridge.identity,
                status: bridge.status,
                subscriberCount: bridge.subscriberCount,
            });
        }
        return result;
    }

    /**
     * Decrement subscriber count for a language. If the last subscriber
     * leaves, stop the bridge and tear down the Gemini session.
     */
    async unsubscribe(sessionId: string, targetLanguage: string): Promise<void> {
        const languageMap = this.translations.get(sessionId);
        if (!languageMap) return;

        const bridge = languageMap.get(targetLanguage);
        if (!bridge) return;

        bridge.subscriberCount = Math.max(0, bridge.subscriberCount - 1);
        log.info(
            {
                remainingSubscribers: bridge.subscriberCount,
                sessionId,
                targetLanguage,
            },
            "Unsubscribed from translation bridge",
        );

        if (bridge.subscriberCount === 0) {
            log.info(
                { sessionId, targetLanguage },
                "No more subscribers; tearing down translation bridge",
            );
            await bridge.stop();
            this.cleanupBridgeReference(sessionId, targetLanguage, bridge);
        }
    }

    async removeTranslation(sessionId: string, targetLanguage: string): Promise<void> {
        const languageMap = this.translations.get(sessionId);
        if (!languageMap) return;

        const bridge = languageMap.get(targetLanguage);
        if (bridge) {
            await bridge.stop();
            this.cleanupBridgeReference(sessionId, targetLanguage, bridge);
            log.info({ sessionId, targetLanguage }, "Removed translation bridge");
        }
    }

    async removeAllTranslations(sessionId: string): Promise<void> {
        this.clearSessionExpirationTimer(sessionId);

        const languageMap = this.translations.get(sessionId);
        if (languageMap) {
            for (const [, bridge] of languageMap) {
                await bridge.stop();
            }
            languageMap.clear();
            this.translations.delete(sessionId);
        }
        this.sessions.delete(sessionId);
        this.stopReconcileTimerIfIdle();
        await this.deleteLiveKitRoom(sessionId);
        log.info({ sessionId }, "Removed all translation bridges and session");
    }

    getAllSessions(): SessionInfo[] {
        return Array.from(this.sessions.values()).filter((session) => {
            if (this.hasSessionExpired(session)) {
                void this.expireSession(session.sessionId, session.expiresAt.getTime());
                return false;
            }

            return true;
        });
    }

    private hasSessionExpired(session: SessionInfo): boolean {
        return session.expiresAt.getTime() <= Date.now();
    }

    private scheduleSessionExpiration(session: SessionInfo): void {
        this.clearSessionExpirationTimer(session.sessionId);

        const delayMs = session.expiresAt.getTime() - Date.now();
        if (delayMs <= 0) {
            void this.expireSession(session.sessionId, session.expiresAt.getTime());
            return;
        }

        const timeout = setTimeout(() => {
            void this.expireSession(session.sessionId, session.expiresAt.getTime());
        }, delayMs);

        timeout.unref?.();
        this.sessionExpirationTimers.set(session.sessionId, timeout);
    }

    private clearSessionExpirationTimer(sessionId: string): void {
        const timeout = this.sessionExpirationTimers.get(sessionId);
        if (timeout) {
            clearTimeout(timeout);
            this.sessionExpirationTimers.delete(sessionId);
        }
    }

    private async expireSession(sessionId: string, expectedExpiresAtMs: number): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session || session.expiresAt.getTime() !== expectedExpiresAtMs) {
            return;
        }

        log.info({ sessionId }, "Session reached its time limit");
        await this.removeAllTranslations(sessionId);
    }

    private async deleteLiveKitRoom(sessionId: string): Promise<void> {
        const roomServiceClient = this.getRoomServiceClient();
        if (!roomServiceClient) return;

        try {
            await roomServiceClient.deleteRoom(sessionId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/not found|does not exist/i.test(message)) {
                return;
            }

            log.error({ err: error, sessionId }, "Failed to delete LiveKit room");
        }
    }

    async reconcileActiveTranslations(): Promise<void> {
        if (this.reconcileInFlight) {
            return this.reconcileInFlight;
        }

        this.reconcileInFlight = this.reconcileActiveTranslationsOnce().finally(() => {
            this.reconcileInFlight = null;
        });

        return this.reconcileInFlight;
    }

    private getRoomServiceClient(): RoomServiceClient | null {
        const credentials = getLiveKitCredentials();

        if (!credentials) {
            log.warn("LiveKit credentials are not configured; skipping LiveKit room operation");
            return null;
        }

        if (!this.roomServiceClient) {
            this.roomServiceClient = new RoomServiceClient(
                getLiveKitApiUrl(),
                credentials.apiKey,
                credentials.apiSecret,
            );
        }

        return this.roomServiceClient;
    }

    private ensureReconcileTimer(): void {
        if (this.reconcileInterval || this.translations.size === 0) return;

        this.reconcileInterval = setInterval(() => {
            void this.reconcileActiveTranslations().catch((error) => {
                log.error({ err: error }, "Translation reconcile failed");
            });
        }, this.reconcileIntervalMs);

        this.reconcileInterval.unref?.();
    }

    private stopReconcileTimerIfIdle(): void {
        if (this.translations.size > 0 || !this.reconcileInterval) return;

        clearInterval(this.reconcileInterval);
        this.reconcileInterval = null;
    }

    private async reconcileActiveTranslationsOnce(): Promise<void> {
        if (this.translations.size === 0) {
            this.stopReconcileTimerIfIdle();
            return;
        }

        const roomServiceClient = this.getRoomServiceClient();
        if (!roomServiceClient) return;

        const now = Date.now();
        const sessionEntries = Array.from(this.translations.entries());

        for (const [sessionId, languageMap] of sessionEntries) {
            const bridges = Array.from(languageMap.entries());
            if (bridges.length === 0) continue;

            let participants: ParticipantInfo[];
            try {
                participants = await roomServiceClient.listParticipants(sessionId);
            } catch (error) {
                log.error({ err: error, sessionId }, "Failed to list LiveKit participants");
                continue;
            }

            const session = this.getSession(sessionId);
            if (!session) continue;

            for (const [targetLanguage, bridge] of bridges) {
                if (this.translations.get(sessionId)?.get(targetLanguage) !== bridge) {
                    continue;
                }

                if (bridge.status !== "active") {
                    await this.stopBridge(
                        sessionId,
                        targetLanguage,
                        bridge,
                        `bridge status is ${bridge.status}`,
                    );
                    continue;
                }

                const actualSubscriberCount = this.countLanguageSubscribers(
                    participants,
                    targetLanguage,
                    session?.organizerIdentity,
                    bridge.identity,
                );

                if (actualSubscriberCount > 0) {
                    if (bridge.subscriberCount !== actualSubscriberCount) {
                        log.info(
                            {
                                actualSubscriberCount,
                                previousSubscriberCount: bridge.subscriberCount,
                                sessionId,
                                targetLanguage,
                            },
                            "Reconciled translation subscriber count",
                        );
                    }

                    bridge.subscriberCount = actualSubscriberCount;
                    this.bridgeLastSubscriberSeenAt.set(bridge, now);
                    continue;
                }

                bridge.subscriberCount = 0;

                const lastSeenAt = this.bridgeLastSubscriberSeenAt.get(bridge) ?? now;
                if (now - lastSeenAt < this.emptyBridgeGraceMs) {
                    continue;
                }

                await this.stopBridge(
                    sessionId,
                    targetLanguage,
                    bridge,
                    `no LiveKit participants have selected ${targetLanguage} for ${this.emptyBridgeGraceMs}ms`,
                );
            }
        }
    }

    private countLanguageSubscribers(
        participants: ParticipantInfo[],
        targetLanguage: string,
        organizerIdentity: string | undefined,
        translatorIdentity: string,
    ): number {
        return participants.filter((participant) => {
            const identity = participant.identity;
            if (!identity) return false;
            if (identity === organizerIdentity || identity === translatorIdentity) {
                return false;
            }
            if (identity.startsWith("organizer-") || identity.startsWith("translator-")) {
                return false;
            }

            return participantWantsTranslation(participant.attributes, targetLanguage);
        }).length;
    }

    private async stopBridge(
        sessionId: string,
        targetLanguage: string,
        bridge: TranslationBridge,
        reason: string,
    ): Promise<void> {
        if (this.translations.get(sessionId)?.get(targetLanguage) !== bridge) {
            return;
        }

        log.info({ reason, sessionId, targetLanguage }, "Stopping translation bridge");

        try {
            await bridge.stop();
        } finally {
            this.cleanupBridgeReference(sessionId, targetLanguage, bridge);
        }
    }

    private cleanupBridgeReference(
        sessionId: string,
        targetLanguage: string,
        bridge: TranslationBridge,
    ): void {
        const languageMap = this.translations.get(sessionId);
        if (!languageMap) {
            this.bridgeLastSubscriberSeenAt.delete(bridge);
            this.stopReconcileTimerIfIdle();
            return;
        }

        if (languageMap.get(targetLanguage) === bridge) {
            languageMap.delete(targetLanguage);
            this.bridgeLastSubscriberSeenAt.delete(bridge);
        }

        if (languageMap.size === 0) {
            this.translations.delete(sessionId);
            log.info({ sessionId }, "Cleaned up active translations after all bridges stopped");
        }

        this.stopReconcileTimerIfIdle();
    }
}

export default TranslationSessionManager;
