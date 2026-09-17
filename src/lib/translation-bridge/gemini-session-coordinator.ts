import { randomUUID } from "node:crypto";

import { createLogger } from "../logger";
import {
    GeminiLiveConnection,
    type GeminiLiveConnectionOptions,
    type GeminiServerMessage,
} from "./gemini-live-connection";

export const WARM_HANDOVER_DEFAULTS = {
    standbyStartAgeMs: 480_000,
    warmupMs: 30_000,
    setupTimeoutMs: 15_000,
    candidateMaxLifetimeMs: 60_000,
    retryCooldownMs: 60_000,
    deadlineGuardMs: 5000,
    emergencyOutputFreshnessMs: 2000,
    closeGraceMs: 1000,
};

type Options = Omit<GeminiLiveConnectionOptions, "onRecoveryRequested" | "onReady"> & {
    sessionId: string;
    timings?: Partial<typeof WARM_HANDOVER_DEFAULTS>;
    onHandover: () => { discardedPendingCaptionChars: number };
};

type Session = {
    id: string;
    connection: GeminiLiveConnection;
    createdAt: number;
    setupAt: number | null;
    warmupAt: number | null;
    lastTextAt: number | null;
    deadlineAt: number | null;
    goAwaySeen: boolean;
};

/** Uses exactly the same output selection as TranslationBridge. Input transcripts never qualify. */
export function hasOutputText(message: GeminiServerMessage): boolean {
    const transcription = message.serverContent?.outputTranscription ?? message.outputTranscription;
    const text =
        transcription?.text ||
        message.serverContent?.modelTurn?.parts?.map((p) => p.text ?? "").join("");
    return Boolean(text?.trim());
}

export function parseGoAwayDuration(value: string | undefined): number | null {
    if (!value || !/^\d+(?:\.\d{1,9})?s$/.test(value)) return null;
    const ms = Number(value.slice(0, -1)) * 1000;
    // Node timers overflow above a signed 32-bit delay and would fire immediately.
    return Number.isFinite(ms) && ms >= 0 && ms <= 2_147_483_647 ? ms : null;
}

/** One public output, up to two independent translators. No output replay or text matching. */
export class GeminiSessionCoordinator {
    private readonly timings;
    private readonly log;
    private active: Session;
    private standby: Session | null = null;
    private stopped = false;
    private paused = false;
    private recovering = false;
    private preparing = false;
    private lifecycle = 0;
    private connectionRevision = 0;
    private retryAttempt = 0;
    private retryAt = 0;
    private waitForActiveText = false;
    private scheduleTimer: NodeJS.Timeout | null = null;
    private candidateTimer: NodeJS.Timeout | null = null;
    private deadlineTimer: NodeJS.Timeout | null = null;
    private recoveryTimer: NodeJS.Timeout | null = null;
    private readonly retiring = new Set<Promise<void>>();
    private readonly retiredConnections = new Set<GeminiLiveConnection>();
    private carriedDrops = 0;
    private carriedResets = 0;
    private activeDropBaseline = 0;
    private handoverCount = 0;
    private fallbackCount = 0;
    private firstTextPending: {
        handoverId: string;
        lastActiveTextReceivedAt: number | null;
        firstNewTextReceivedAt: number | null;
        handoverCommittedAt: number;
    } | null = null;

    constructor(private readonly options: Options) {
        this.timings = { ...WARM_HANDOVER_DEFAULTS, ...options.timings };
        this.log = createLogger({
            component: "gemini-session-coordinator",
            sessionId: options.sessionId,
            targetLanguage: options.targetLanguage,
        });
        this.active = this.createSession();
    }

    private createSession(): Session {
        const session: Session = {
            id: randomUUID(),
            connection: undefined as unknown as GeminiLiveConnection,
            createdAt: performance.now(),
            setupAt: null,
            warmupAt: null,
            lastTextAt: null,
            deadlineAt: null,
            goAwaySeen: false,
        };
        session.connection = new GeminiLiveConnection({
            ...this.options,
            connectionId: session.id,
            setupTimeoutMs: this.timings.setupTimeoutMs,
            closeGraceMs: this.timings.closeGraceMs,
            shouldReconnect: () => this.isCurrent(session) && this.options.shouldReconnect(),
            onMessage: (message) => this.receive(session, message),
            onReady: () => this.ready(session),
            onRecoveryRequested: (reason, fresh) => this.requestRecovery(session, reason, fresh),
            onDiscontinuity: () => {
                if (this.isCurrent(session) && session === this.active)
                    this.options.onDiscontinuity?.();
            },
        });
        return session;
    }

    async connect(): Promise<void> {
        await this.active.connection.connect();
    }
    get revision(): number {
        return this.connectionRevision;
    }
    get isReady(): boolean {
        return !this.stopped && this.active.connection.isReady;
    }
    get isRecovering(): boolean {
        return !this.stopped && (this.recovering || this.active.connection.isRecovering);
    }
    endAudioInput(): boolean {
        return !this.stopped && this.active.connection.endAudioInput();
    }
    recordDroppedInput(ms: number): void {
        this.carriedDrops += Math.max(0, ms);
    }

    getInputDiagnostics() {
        const active = this.active.connection.getInputDiagnostics();
        return {
            ...active,
            droppedInputMs: Math.round(
                this.carriedDrops + active.droppedInputMs - this.activeDropBaseline,
            ),
            resets: this.carriedResets + active.resets,
            recovering: this.isRecovering,
            handover: {
                state: this.stopped
                    ? "stopped"
                    : this.recovering
                      ? "recovering"
                      : this.paused
                        ? "paused"
                        : this.standby
                          ? "warming"
                          : "idle",
                activeConnectionId: this.active.id,
                standbyConnectionId: this.standby?.id ?? null,
                warmupMs:
                    this.standby?.warmupAt == null ? 0 : performance.now() - this.standby.warmupAt,
                standbyDroppedInputMs:
                    this.standby?.connection.getInputDiagnostics().droppedInputMs ?? 0,
                handoverCount: this.handoverCount,
                fallbackCount: this.fallbackCount,
                openConnections: this.socketCount,
            },
        };
    }

    sendAudio(audio: string, rate: number): boolean {
        if (this.stopped) return false;
        const active = this.active;
        const sent = active.connection.sendAudio(audio, rate);
        // A synchronous send failure may promote B. Each socket still gets this packet once.
        const candidate = this.standby ?? (this.active !== active ? this.active : null);
        if (candidate?.connection.isReady) {
            const accepted = candidate.connection.sendAudio(audio, rate);
            if (candidate === this.standby) {
                if (!accepted || candidate.connection.isRecovering)
                    this.cancelCandidate("input_congestion", true);
                else if (candidate.warmupAt === null) {
                    candidate.warmupAt = performance.now();
                    this.event("gemini_standby_warmup_started", candidate);
                }
            }
            return this.active === candidate ? accepted : sent;
        }
        return sent;
    }

    /** Called before owner drain/reset; does not pause forced recovery. */
    pauseHandover(): void {
        this.paused = true;
        this.clearTimer("scheduleTimer");
        this.cancelCandidate("manual_operation");
    }

    resumeHandover(): void {
        this.paused = false;
        this.schedule();
    }

    async resetFresh(): Promise<void> {
        const paused = this.paused;
        this.pauseHandover();
        this.clearTimer("recoveryTimer");
        this.clearTimer("deadlineTimer");
        const revision = ++this.lifecycle;
        this.connectionRevision++;
        this.recovering = true;
        this.active.setupAt = null;
        this.active.deadlineAt = null;
        this.firstTextPending = null;
        try {
            // Retire A immediately as history is already reset. Wait for B's slot only
            // before opening the replacement, never while A can still publish old text.
            await this.active.connection.recoverManaged(true, () => this.waitForRetired());
        } catch (error) {
            if (!this.stopped && revision === this.lifecycle) {
                this.paused = paused;
                this.recovering = false;
                this.beginRecovery("reset_failed", false);
            }
            throw error;
        } finally {
            if (!this.stopped && revision === this.lifecycle) {
                this.paused = paused;
                this.schedule();
            }
        }
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.lifecycle++;
        this.clearTimer("scheduleTimer");
        this.clearTimer("recoveryTimer");
        this.clearTimer("deadlineTimer");
        this.cancelCandidate("stopped");
        this.retire(this.active, "stopped");
        this.firstTextPending = null;
    }

    async waitForRetired(): Promise<void> {
        await Promise.all(this.retiring);
    }

    /** Bridge calls this at the actual caption queue boundary, including its interim throttle. */
    markTextQueued(): void {
        const pending = this.firstTextPending;
        if (!pending || pending.firstNewTextReceivedAt === null) return;
        this.firstTextPending = null;
        this.event("gemini_handover_first_text_queued", this.active, {
            ...pending,
            firstNewTextQueuedAt: performance.now(),
            handoverTextGapMs:
                pending.lastActiveTextReceivedAt === null
                    ? null
                    : pending.firstNewTextReceivedAt - pending.lastActiveTextReceivedAt,
        });
    }

    private ready(session: Session): void {
        if (!this.isCurrent(session)) return;
        session.setupAt = performance.now();
        session.deadlineAt = null;
        session.goAwaySeen = false;
        session.lastTextAt = null;
        if (session === this.active) {
            this.connectionRevision++;
            this.recovering = false;
            this.retryAttempt = 0;
            this.clearTimer("deadlineTimer");
            this.schedule();
        } else
            this.event("gemini_standby_setup_complete", session, {
                setupMs: session.setupAt - session.createdAt,
            });
    }

    private receive(session: Session, message: GeminiServerMessage): void {
        if (!this.isCurrent(session)) return;
        if (message.goAway) this.goAway(session, message.goAway.timeLeft);
        if (!this.isCurrent(session)) return;
        const text = hasOutputText(message);
        if (text) session.lastTextAt = performance.now();
        if (session === this.standby) {
            if (
                text &&
                !this.paused &&
                session.warmupAt !== null &&
                performance.now() - session.warmupAt >= this.timings.warmupMs &&
                this.healthyCandidate(session)
            )
                this.commit(session, "warmed");
            else return;
        }
        if (session !== this.active || this.stopped) return;
        if (text) {
            if (this.firstTextPending && this.firstTextPending.firstNewTextReceivedAt === null)
                this.firstTextPending.firstNewTextReceivedAt = performance.now();
            if (this.waitForActiveText) {
                this.waitForActiveText = false;
                this.schedule();
            }
        }
        this.options.onMessage(message);
    }

    private schedule(): void {
        this.clearTimer("scheduleTimer");
        if (
            this.stopped ||
            this.paused ||
            this.recovering ||
            this.standby ||
            this.preparing ||
            this.waitForActiveText ||
            this.active.setupAt === null
        )
            return;
        const due = Math.max(
            this.active.goAwaySeen
                ? performance.now()
                : this.active.setupAt + this.timings.standbyStartAgeMs,
            this.retryAt,
        );
        this.scheduleTimer = setTimeout(
            () => {
                this.scheduleTimer = null;
                void this.prepareCandidate("scheduled");
            },
            Math.max(0, due - performance.now()),
        );
    }

    private async prepareCandidate(reason: string): Promise<void> {
        if (
            this.stopped ||
            this.paused ||
            this.recovering ||
            this.standby ||
            this.preparing ||
            !this.options.shouldReconnect()
        )
            return;
        this.preparing = true;
        const revision = this.lifecycle;
        const active = this.active;
        try {
            if (this.retiring.size) await this.waitForRetired();
            if (
                this.stopped ||
                this.paused ||
                this.recovering ||
                revision !== this.lifecycle ||
                active !== this.active
            )
                return;
            const candidate = this.createSession();
            this.standby = candidate;
            this.clearTimer("scheduleTimer");
            this.candidateTimer = setTimeout(
                () => this.cancelCandidate("candidate_timeout", true),
                this.timings.candidateMaxLifetimeMs,
            );
            const connecting = candidate.connection.connect();
            this.event("gemini_standby_started", candidate, { reason });
            void connecting.catch((error) => {
                if (candidate === this.standby)
                    this.cancelCandidate(this.classifyFailure(error), true);
            });
        } finally {
            this.preparing = false;
        }
    }

    private cancelCandidate(reason: string, failed = false): void {
        this.clearTimer("candidateTimer");
        const candidate = this.standby;
        this.standby = null;
        if (!candidate) return;
        this.event(failed ? "gemini_standby_failed" : "gemini_standby_cancelled", candidate, {
            reason,
        });
        this.retire(candidate, reason);
        if (failed) {
            this.retryAt = performance.now() + this.timings.retryCooldownMs;
            this.waitForActiveText = true;
        }
    }

    private healthyCandidate(candidate: Session): boolean {
        return (
            candidate.connection.isReady &&
            !candidate.connection.isRecovering &&
            !candidate.goAwaySeen
        );
    }

    private emergencyCandidate(): Session | null {
        const candidate = this.standby;
        return !this.paused &&
            candidate &&
            this.healthyCandidate(candidate) &&
            candidate.lastTextAt !== null &&
            performance.now() - candidate.lastTextAt <= this.timings.emergencyOutputFreshnessMs
            ? candidate
            : null;
    }

    private commit(candidate: Session, reason: string): void {
        if (
            this.stopped ||
            this.paused ||
            candidate !== this.standby ||
            !this.healthyCandidate(candidate)
        )
            return;
        const old = this.active;
        this.clearTimer("candidateTimer");
        this.clearTimer("deadlineTimer");
        this.clearTimer("scheduleTimer");
        this.clearTimer("recoveryTimer");
        this.lifecycle++;
        const diagnostics = this.getInputDiagnostics();
        this.carriedDrops = diagnostics.droppedInputMs;
        this.carriedResets = diagnostics.resets;
        this.activeDropBaseline = candidate.connection.getInputDiagnostics().droppedInputMs;
        this.active = candidate;
        this.standby = null;
        this.recovering = false;
        this.connectionRevision++;
        this.retryAttempt = 0;
        this.retryAt = 0;
        this.waitForActiveText = false;
        this.handoverCount++;
        const handoverId = candidate.id;
        this.firstTextPending = {
            handoverId,
            lastActiveTextReceivedAt: old.lastTextAt,
            firstNewTextReceivedAt: null,
            handoverCommittedAt: performance.now(),
        };
        const boundary = this.options.onHandover();
        this.retire(old, "replaced");
        this.event("gemini_handover_committed", candidate, {
            reason,
            oldConnectionId: old.id,
            newConnectionId: candidate.id,
            ...this.firstTextPending,
            ...boundary,
        });
        this.schedule();
    }

    private goAway(session: Session, duration: string | undefined): void {
        const first = !session.goAwaySeen;
        session.goAwaySeen = true;
        if (session === this.standby) {
            this.cancelCandidate("standby_goaway", true);
            return;
        }
        const left = parseGoAwayDuration(duration);
        if (left === null) {
            const candidate = this.emergencyCandidate();
            if (candidate) this.commit(candidate, "unknown_deadline");
            else this.beginRecovery("unknown_deadline", false);
            return;
        }
        session.deadlineAt = Math.min(session.deadlineAt ?? Infinity, performance.now() + left);
        this.clearTimer("deadlineTimer");
        const remaining = session.deadlineAt - performance.now() - this.timings.deadlineGuardMs;
        if (remaining <= 0) {
            this.deadlineReached(session);
            return;
        }
        this.deadlineTimer = setTimeout(() => this.deadlineReached(session), remaining);
        if (
            first &&
            (performance.now() >= this.retryAt ||
                remaining >= this.timings.setupTimeoutMs + this.timings.warmupMs)
        ) {
            this.waitForActiveText = false;
            void this.prepareCandidate("goaway");
        }
    }

    private deadlineReached(session: Session): void {
        if (!this.isCurrent(session) || session !== this.active) return;
        const candidate = this.emergencyCandidate();
        if (candidate) this.commit(candidate, "deadline");
        else this.beginRecovery("deadline", false);
    }

    private requestRecovery(session: Session, reason: string, fresh: boolean): void {
        if (!this.isCurrent(session)) return;
        if (session === this.standby) {
            this.cancelCandidate(reason, true);
            return;
        }
        const candidate = this.emergencyCandidate();
        if (candidate) this.commit(candidate, "active_failed");
        else this.beginRecovery(reason, fresh);
    }

    private beginRecovery(reason: string, fresh: boolean): void {
        if (this.stopped || this.recovering || !this.options.shouldReconnect()) return;
        this.recovering = true;
        this.connectionRevision++;
        this.lifecycle++;
        this.fallbackCount++;
        this.firstTextPending = null;
        this.clearTimer("scheduleTimer");
        this.clearTimer("deadlineTimer");
        this.cancelCandidate("active_recovery");
        this.event("gemini_handover_fallback", this.active, { reason, fresh });
        this.queueRecovery(fresh);
    }

    private queueRecovery(fresh: boolean): void {
        const revision = this.lifecycle;
        const baseMs = Math.min(500 * 2 ** Math.min(this.retryAttempt++, 6), 30_000);
        this.recoveryTimer = setTimeout(
            () => {
                this.recoveryTimer = null;
                void (async () => {
                    await this.waitForRetired();
                    if (this.stopped || revision !== this.lifecycle) return;
                    await this.active.connection.recoverManaged(fresh);
                })().catch((error) => {
                    if (this.stopped || revision !== this.lifecycle) return;
                    this.event("gemini_recovery_failed", this.active, {
                        reason: this.classifyFailure(error),
                    });
                    this.queueRecovery(fresh);
                });
            },
            Math.round(baseMs * (1 + Math.random() * 0.2)),
        );
    }

    private retire(session: Session, reason: string): void {
        session.connection.stop();
        this.retiredConnections.add(session.connection);
        const closed = session.connection.waitForRetired();
        this.retiring.add(closed);
        void closed.then(() => {
            this.retiring.delete(closed);
            this.retiredConnections.delete(session.connection);
            this.event("gemini_connection_retired", session, { reason });
        });
    }

    private isCurrent(session: Session): boolean {
        return !this.stopped && (session === this.active || session === this.standby);
    }

    private get socketCount(): number {
        const connections = new Set(this.retiredConnections);
        connections.add(this.active.connection);
        if (this.standby) connections.add(this.standby.connection);
        return [...connections].reduce((count, connection) => count + connection.socketCount, 0);
    }

    private clearTimer(
        key: "scheduleTimer" | "candidateTimer" | "deadlineTimer" | "recoveryTimer",
    ): void {
        if (this[key]) clearTimeout(this[key]);
        this[key] = null;
    }

    private classifyFailure(error: unknown): string {
        const text = error instanceof Error ? error.message : "";
        if (/quota|resource_exhausted|429/i.test(text)) return "quota";
        if (/permission|unauth|api.key|401|403/i.test(text)) return "authorization";
        if (/timeout/i.test(text)) return "setup_timeout";
        return "connection_failed";
    }

    private event(event: string, session: Session, details: Record<string, unknown> = {}): void {
        const now = performance.now();
        this.log.info(
            {
                event,
                openConnections: this.socketCount,
                connectionId: session.id,
                socketRevision: session.connection.revision,
                handoverId: this.standby?.id ?? session.id,
                role: session === this.active ? "active" : "standby",
                activeConnectionId: this.active.id,
                connectionAgeMs: session.setupAt === null ? null : now - session.setupAt,
                warmupMs: session.warmupAt === null ? 0 : now - session.warmupAt,
                deadlineRemainingMs: session.deadlineAt === null ? null : session.deadlineAt - now,
                lastTextAgeMs: session.lastTextAt === null ? null : now - session.lastTextAt,
                input: session.connection.getInputDiagnostics(),
                ...details,
            },
            event,
        );
    }
}
