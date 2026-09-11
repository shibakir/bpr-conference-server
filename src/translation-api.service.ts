import { randomBytes, randomUUID } from "node:crypto";

import { HttpException, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { AccessToken } from "livekit-server-sdk";
import type { z } from "zod";

import { updateTranslationSettingsSchema } from "./lib/translation-settings";

import type { Locale } from "./i18n/locales";
import { API_ERROR_CODES, apiError } from "./lib/api-errors";
import {
    createSessionRequestSchema,
    deleteSessionRequestSchema,
    presenterLeaseRequestSchema,
    tokenQuerySchema,
    translateStatusQuerySchema,
    translationRequestSchema,
    zodErrorDetails,
} from "./lib/api-schemas";
import { getLanguageByCode } from "./lib/languages";
import { createLogger } from "./lib/logger";
import { getConfiguredAttendeeOrigin } from "./lib/public-origin";
import { getBroadcastPassword, getLiveKitCredentials, getLiveKitUrl } from "./lib/server-env";
import { MAX_SESSION_DURATION_MINUTES, MIN_SESSION_DURATION_MINUTES } from "./lib/session-duration";
import TranslationSessionManager, {
    hashOrganizerKey,
    type SessionInfo,
} from "./lib/translation-session-manager";

export type RequestHeaders = Record<string, string | string[] | undefined>;
export type RequestQuery = Record<string, string | string[] | undefined>;

const log = createLogger({ service: "translation-api" });

function getSessionPath(locale: Locale, sessionId: string, mode: "watch" | "broadcast") {
    return `/${locale}/session/${sessionId}/${mode}`;
}

function getHeader(headers: RequestHeaders, name: string) {
    const value = headers[name.toLowerCase()] ?? headers[name];
    if (Array.isArray(value)) {
        return value[0];
    }

    return value;
}

function getForwardedHeaderValue(value: string | undefined) {
    return value?.split(",")[0]?.trim();
}

function getRequestOrigin(headers: RequestHeaders) {
    const protocol = getForwardedHeaderValue(getHeader(headers, "x-forwarded-proto")) || "http";
    const host =
        getForwardedHeaderValue(getHeader(headers, "x-forwarded-host")) ||
        getForwardedHeaderValue(getHeader(headers, "host")) ||
        "localhost:3000";

    return `${protocol}://${host}`;
}

function hasValidationIssue(error: z.ZodError, field: string) {
    return error.issues.some((issue) => issue.path[0] === field);
}

function toQueryObject(query: RequestQuery): Record<string, string> {
    const entries = Object.entries(query).flatMap(([key, value]) => {
        if (typeof value === "string") {
            return [[key, value] as const];
        }

        if (Array.isArray(value)) {
            const lastValue = value.at(-1);
            return typeof lastValue === "string" ? [[key, lastValue] as const] : [];
        }

        return [];
    });

    return Object.fromEntries(entries);
}

function shortSessionId() {
    return randomUUID().slice(0, 8);
}

function createOrganizerKey() {
    return randomBytes(32).toString("base64url");
}

function toPublicSession(session: SessionInfo) {
    return {
        allowedLanguages: session.allowedLanguages,
        createdAt: session.createdAt,
        durationMinutes: session.durationMinutes,
        enableAudioTranslation: session.enableAudioTranslation,
        enableTranscription: session.enableTranscription,
        expiresAt: session.expiresAt,
        organizerIdentity: session.organizerIdentity,
        sessionId: session.sessionId,
    };
}

function throwApiError(
    status: number,
    code: (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES],
    message: string,
    details?: Record<string, unknown>,
): never {
    throw new HttpException(apiError(code, message, details), status);
}

function invalidCreateSessionRequest(error: z.ZodError): never {
    if (hasValidationIssue(error, "durationMinutes")) {
        return throwApiError(
            400,
            API_ERROR_CODES.INVALID_SESSION_DURATION,
            `Session duration must be between ${MIN_SESSION_DURATION_MINUTES} and ${MAX_SESSION_DURATION_MINUTES} minutes`,
            {
                ...zodErrorDetails(error),
                min: MIN_SESSION_DURATION_MINUTES,
                max: MAX_SESSION_DURATION_MINUTES,
            },
        );
    }

    if (hasValidationIssue(error, "locale")) {
        return throwApiError(
            400,
            API_ERROR_CODES.INVALID_LOCALE,
            "Invalid locale",
            zodErrorDetails(error),
        );
    }

    return throwApiError(
        400,
        API_ERROR_CODES.INVALID_REQUEST,
        "Invalid session request",
        zodErrorDetails(error),
    );
}

@Injectable()
export class TranslationApiService implements OnApplicationShutdown {
    private readonly manager = TranslationSessionManager.getInstance();

    getAuthStatus() {
        return { passwordRequired: !!getBroadcastPassword() };
    }

    async createSession(body: unknown, headers: RequestHeaders) {
        try {
            const parsed = createSessionRequestSchema.safeParse(body ?? {});
            if (!parsed.success) {
                return invalidCreateSessionRequest(parsed.error);
            }

            const {
                durationMinutes,
                eventId,
                locale,
                organizerName,
                password,
                translationOutputs,
            } = parsed.data;

            let enableAudioTranslation = parsed.data.enableAudioTranslation !== false;
            let enableTranscription = parsed.data.enableTranscription === true;

            if (translationOutputs !== undefined) {
                const normalizedOutputs = Array.from(new Set(translationOutputs));

                enableAudioTranslation = normalizedOutputs.includes("audio");
                enableTranscription = normalizedOutputs.includes("text");
            }

            let allowedLanguages: string[] | undefined = undefined;
            if (Array.isArray(parsed.data.allowedLanguages)) {
                const normalizedAllowedLanguages = parsed.data.allowedLanguages
                    .filter((language): language is string => typeof language === "string")
                    .map((language) => getLanguageByCode(language)?.code)
                    .filter((language): language is string => typeof language === "string");

                allowedLanguages = Array.from(new Set(normalizedAllowedLanguages));
            }

            const expectedPassword = getBroadcastPassword();
            if (expectedPassword && password !== expectedPassword) {
                return throwApiError(401, API_ERROR_CODES.INCORRECT_PASSWORD, "Incorrect password");
            }

            let sessionId: string;
            if (eventId && eventId.trim().length > 0) {
                sessionId = eventId
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9-_]+/g, "-")
                    .replace(/^-+|-+$/g, "");

                if (sessionId.length === 0) {
                    sessionId = shortSessionId();
                }
            } else {
                sessionId = shortSessionId();
            }

            const organizerIdentity = `organizer-${organizerName}`;
            const organizerKey = createOrganizerKey();

            if (this.manager.hasSession(sessionId)) {
                log.info(
                    { sessionId },
                    "Overwriting existing session; tearing down previous bridges",
                );
                await this.manager.removeAllTranslations(sessionId);
            }

            this.manager.createSession(sessionId, organizerIdentity, {
                enableAudioTranslation,
                enableTranscription,
                organizerKeyHash: hashOrganizerKey(organizerKey),
                durationMinutes,
                ...(allowedLanguages ? { allowedLanguages } : {}),
                ...(parsed.data.systemInstruction
                    ? { systemInstruction: parsed.data.systemInstruction }
                    : {}),
            });
            const session = this.manager.getSession(sessionId);

            const requestOrigin = getRequestOrigin(headers);
            const attendeeOrigin = getConfiguredAttendeeOrigin() || requestOrigin;
            const joinUrl = `${attendeeOrigin}${getSessionPath(locale, sessionId, "watch")}`;

            return {
                sessionId,
                organizerIdentity,
                organizerKey,
                locale,
                enableAudioTranslation,
                enableTranscription,
                translationOutputs: [
                    ...(enableAudioTranslation ? ["audio"] : []),
                    ...(enableTranscription ? ["text"] : []),
                ],
                durationMinutes,
                expiresAt: session?.expiresAt.toISOString(),
                joinUrl,
                broadcastUrl: `${requestOrigin}${getSessionPath(locale, sessionId, "broadcast")}`,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            log.error({ err: error }, "Error creating session");
            return throwApiError(
                500,
                API_ERROR_CODES.CREATE_SESSION_FAILED,
                "Failed to create session",
            );
        }
    }

    getSessions() {
        return { sessions: this.manager.getAllSessions().map(toPublicSession) };
    }

    getSession(sessionId: string) {
        const session = this.manager.getSession(sessionId);

        if (!session) {
            return throwApiError(404, API_ERROR_CODES.SESSION_NOT_FOUND, "Session not found");
        }

        const translations = this.manager.getActiveTranslations(sessionId);

        return {
            ...toPublicSession(session),
            translations,
        };
    }

    getPresenterStatus(sessionId: string) {
        const status = this.manager.getPresenterStatus(sessionId);

        if (!status) {
            return throwApiError(404, API_ERROR_CODES.SESSION_NOT_FOUND, "Session not found");
        }

        return {
            active: status.active,
            ...(status.leaseExpiresAt
                ? { leaseExpiresAt: status.leaseExpiresAt.toISOString() }
                : {}),
        };
    }

    claimPresenter(sessionId: string, body: unknown) {
        const parsed = presenterLeaseRequestSchema.safeParse(body ?? {});
        if (!parsed.success) {
            return throwApiError(
                400,
                API_ERROR_CODES.INVALID_REQUEST,
                "Missing organizer key or presenter client id",
                zodErrorDetails(parsed.error),
            );
        }

        const { clientId, organizerKey, takeover } = parsed.data;
        const claim = this.manager.claimPresenter(sessionId, organizerKey, clientId, {
            takeover: takeover === true,
        });

        if (claim.status === "session_missing") {
            return throwApiError(404, API_ERROR_CODES.SESSION_NOT_FOUND, "Session not found");
        }

        if (claim.status === "invalid_key") {
            return throwApiError(
                401,
                API_ERROR_CODES.ORGANIZER_ACCESS_REQUIRED,
                "Organizer access required",
            );
        }

        if (claim.status === "already_active") {
            return throwApiError(
                409,
                API_ERROR_CODES.BROADCAST_ALREADY_ACTIVE,
                "Broadcast controls are already active elsewhere",
                { leaseExpiresAt: claim.leaseExpiresAt.toISOString() },
            );
        }

        return {
            active: true,
            leaseExpiresAt: claim.leaseExpiresAt.toISOString(),
        };
    }

    async deleteSession(sessionId: string, body: unknown) {
        const parsed = deleteSessionRequestSchema.safeParse(body ?? {});
        if (!parsed.success) {
            return throwApiError(
                401,
                API_ERROR_CODES.ORGANIZER_ACCESS_REQUIRED,
                "Organizer access required",
                zodErrorDetails(parsed.error),
            );
        }

        const session = this.manager.getSession(sessionId);
        if (!session) {
            return throwApiError(404, API_ERROR_CODES.SESSION_NOT_FOUND, "Session not found");
        }

        if (!this.manager.isOrganizerKeyValid(sessionId, parsed.data.organizerKey)) {
            return throwApiError(
                401,
                API_ERROR_CODES.ORGANIZER_ACCESS_REQUIRED,
                "Organizer access required",
            );
        }

        await this.manager.removeAllTranslations(sessionId);
        return { success: true };
    }

    async getToken(query: RequestQuery) {
        const parsed = tokenQuerySchema.safeParse(toQueryObject(query));
        if (!parsed.success) {
            return throwApiError(
                400,
                API_ERROR_CODES.INVALID_REQUEST,
                "Missing room or identity parameter",
                zodErrorDetails(parsed.error),
            );
        }

        const { identity, organizerKey, presenterClientId, role, room } = parsed.data;
        const isOrganizer = role === "organizer";

        const session = this.manager.getSession(room);
        log.info({ found: !!session, room }, "Checking session for token request");
        if (!session) {
            return throwApiError(
                404,
                API_ERROR_CODES.SESSION_INACTIVE,
                "Broadcast session has not started yet or has ended",
            );
        }

        if (isOrganizer) {
            if (
                !organizerKey ||
                !presenterClientId ||
                !this.manager.isOrganizerKeyValid(room, organizerKey)
            ) {
                return throwApiError(
                    401,
                    API_ERROR_CODES.ORGANIZER_ACCESS_REQUIRED,
                    "Organizer access required",
                );
            }

            if (!this.manager.hasActivePresenterLease(room, organizerKey, presenterClientId)) {
                const status = this.manager.getPresenterStatus(room);
                return throwApiError(
                    409,
                    API_ERROR_CODES.BROADCAST_ALREADY_ACTIVE,
                    "Broadcast controls are already active elsewhere",
                    status?.leaseExpiresAt
                        ? { leaseExpiresAt: status.leaseExpiresAt.toISOString() }
                        : undefined,
                );
            }
        }

        const credentials = getLiveKitCredentials();
        if (!credentials) {
            return throwApiError(
                500,
                API_ERROR_CODES.LIVEKIT_NOT_CONFIGURED,
                "LiveKit credentials not configured",
            );
        }

        const remainingSeconds = Math.max(
            1,
            Math.ceil((session.expiresAt.getTime() - Date.now()) / 1000),
        );
        const at = new AccessToken(credentials.apiKey, credentials.apiSecret, {
            identity: isOrganizer ? session.organizerIdentity : identity,
            name: isOrganizer ? session.organizerIdentity : identity,
            ttl: remainingSeconds,
        });

        at.addGrant({
            roomJoin: true,
            room,
            canPublish: isOrganizer,
            canSubscribe: true,
            canPublishData: isOrganizer,
            canUpdateOwnMetadata: true,
        });

        const token = await at.toJwt();

        return {
            token,
            serverUrl: getLiveKitUrl(),
            durationMinutes: session.durationMinutes,
            expiresAt: session.expiresAt.toISOString(),
        };
    }

    async startTranslation(body: unknown) {
        try {
            const parsed = translationRequestSchema.safeParse(body ?? {});
            if (!parsed.success) {
                return throwApiError(
                    400,
                    API_ERROR_CODES.INVALID_REQUEST,
                    "Missing sessionId or targetLanguage",
                    zodErrorDetails(parsed.error),
                );
            }

            const { previousLanguage, sessionId, targetLanguage } = parsed.data;
            const session = this.manager.getSession(sessionId);

            if (!session) {
                return throwApiError(404, API_ERROR_CODES.SESSION_NOT_FOUND, "Session not found");
            }

            const normalizedTargetLanguage =
                targetLanguage === "original"
                    ? "original"
                    : getLanguageByCode(targetLanguage)?.code;

            if (!normalizedTargetLanguage) {
                return throwApiError(
                    400,
                    API_ERROR_CODES.UNSUPPORTED_TARGET_LANGUAGE,
                    `Unsupported target language "${targetLanguage}"`,
                    { targetLanguage },
                );
            }

            if (
                normalizedTargetLanguage !== "original" &&
                session.allowedLanguages &&
                !session.allowedLanguages.includes(normalizedTargetLanguage)
            ) {
                return throwApiError(
                    400,
                    API_ERROR_CODES.LANGUAGE_NOT_ALLOWED,
                    `Language "${normalizedTargetLanguage}" is not allowed for this session`,
                    { language: normalizedTargetLanguage },
                );
            }

            if (previousLanguage && previousLanguage !== "original") {
                const normalizedPreviousLanguage =
                    getLanguageByCode(previousLanguage)?.code ?? previousLanguage;
                await this.manager.unsubscribe(sessionId, normalizedPreviousLanguage);
            }

            if (normalizedTargetLanguage === "original") {
                return {
                    translatorIdentity: null,
                    status: "original",
                    message: "Using original audio",
                };
            }

            const enableAudioTranslation = session.enableAudioTranslation !== false;

            if (!enableAudioTranslation && !session.enableTranscription) {
                return throwApiError(
                    400,
                    API_ERROR_CODES.TRANSLATION_OUTPUTS_DISABLED,
                    "Translation outputs are disabled for this session",
                );
            }

            const bridge = await this.manager.getOrCreate(
                sessionId,
                normalizedTargetLanguage,
                session.organizerIdentity,
                {
                    enableAudioTranslation,
                    enableTranscription: session.enableTranscription,
                },
            );

            return {
                translatorIdentity: bridge.identity,
                status: bridge.status,
                targetLanguage: bridge.targetLanguage,
                enableAudioTranslation,
                enableTranscription: session.enableTranscription,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            log.error({ err: error }, "Error requesting translation");
            const message = error instanceof Error ? error.message : String(error);
            if (message === "Session has ended") {
                return throwApiError(410, API_ERROR_CODES.SESSION_INACTIVE, "Session has ended");
            }

            return throwApiError(
                500,
                API_ERROR_CODES.TRANSLATION_START_FAILED,
                "Failed to start translation",
            );
        }
    }

    async unsubscribe(body: unknown) {
        try {
            const parsed = translationRequestSchema.safeParse(body ?? {});
            if (!parsed.success) {
                return throwApiError(
                    400,
                    API_ERROR_CODES.INVALID_REQUEST,
                    "Missing sessionId or targetLanguage",
                    zodErrorDetails(parsed.error),
                );
            }

            const { sessionId, targetLanguage } = parsed.data;
            await this.manager.unsubscribe(sessionId, targetLanguage);

            return { success: true };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            log.error({ err: error }, "Error unsubscribing from translation");
            return throwApiError(500, API_ERROR_CODES.UNSUBSCRIBE_FAILED, "Failed to unsubscribe");
        }
    }

    getTranslationSettings(sessionId: string, headers: RequestHeaders) {
        this.requireTranslationSettingsOwner(sessionId, getHeader(headers, "x-organizer-key"));
        return this.manager.getTranslationSettings(sessionId);
    }

    updateTranslationSettings(sessionId: string, body: unknown) {
        const parsed = updateTranslationSettingsSchema.safeParse(body);
        if (!parsed.success)
            return throwApiError(
                400,
                API_ERROR_CODES.INVALID_REQUEST,
                "Invalid translation settings",
                zodErrorDetails(parsed.error),
            );
        this.requireTranslationSettingsOwner(sessionId, parsed.data.organizerKey);
        const current = this.manager.getTranslationSettings(sessionId)!;
        if (current.settings.version !== parsed.data.expectedVersion) {
            return throwApiError(
                409,
                API_ERROR_CODES.INVALID_REQUEST,
                "Translation settings changed; refresh and retry",
                { currentVersion: current.settings.version },
            );
        }
        return this.manager.updateTranslationSettings(
            sessionId,
            {
                inputFrameSizeMs: parsed.data.inputFrameSizeMs,
                maxOutputBacklogMs: parsed.data.maxOutputBacklogMs,
            },
            parsed.data.preset ?? "manual",
        );
    }

    private requireTranslationSettingsOwner(
        sessionId: string,
        organizerKey: string | undefined,
    ): void {
        if (!this.manager.getSession(sessionId)) {
            throwApiError(404, API_ERROR_CODES.SESSION_NOT_FOUND, "Session not found");
        }
        if (!organizerKey || !this.manager.isOrganizerKeyValid(sessionId, organizerKey)) {
            throwApiError(
                403,
                API_ERROR_CODES.ORGANIZER_ACCESS_REQUIRED,
                "Organizer access required",
            );
        }
    }

    getTranslationStatus(query: RequestQuery) {
        const parsed = translateStatusQuerySchema.safeParse(toQueryObject(query));
        if (!parsed.success) {
            return throwApiError(
                400,
                API_ERROR_CODES.INVALID_REQUEST,
                "Missing sessionId parameter",
                zodErrorDetails(parsed.error),
            );
        }

        return {
            translations: this.manager.getActiveTranslations(parsed.data.sessionId),
        };
    }

    async onApplicationShutdown(signal?: string) {
        const sessions = this.manager.getAllSessions();

        for (const session of sessions) {
            await this.manager.removeAllTranslations(session.sessionId);
        }

        log.info({ sessionCount: sessions.length, signal }, "Translation API shutdown completed");
    }
}
