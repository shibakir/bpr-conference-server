import { z } from "zod";

import { defaultLocale, locales } from "../i18n/locales";
import { API_ERROR_CODES, type ApiErrorCode } from "./api-errors";
import {
    DEFAULT_SESSION_DURATION_MINUTES,
    MAX_SESSION_DURATION_MINUTES,
    MIN_SESSION_DURATION_MINUTES,
} from "./session-duration";
import { TRANSLATION_OUTPUT_MODES } from "./session-types";

const apiErrorCodes = Object.values(API_ERROR_CODES) as [ApiErrorCode, ...ApiErrorCode[]];

export const apiErrorResponseSchema = z
    .object({
        code: z.enum(apiErrorCodes).optional(),
        details: z.record(z.string(), z.unknown()).optional(),
        error: z.string().optional(),
    })
    .passthrough();

export const localeSchema = z.enum(locales);
export const translationOutputModeSchema = z.enum(TRANSLATION_OUTPUT_MODES);

export const sessionDurationMinutesSchema = z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
        return DEFAULT_SESSION_DURATION_MINUTES;
    }

    return typeof value === "string" ? Number(value) : value;
}, z.number().int().min(MIN_SESSION_DURATION_MINUTES).max(MAX_SESSION_DURATION_MINUTES));

const organizerNameSchema = z.preprocess(
    (value) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : "organizer"),
    z.string(),
);

export const createSessionRequestSchema = z.object({
    allowedLanguages: z.array(z.string()).min(1).optional(),
    durationMinutes: sessionDurationMinutesSchema,
    enableAudioTranslation: z.boolean().optional(),
    enableTranscription: z.boolean().optional(),
    eventId: z.string().optional(),
    locale: localeSchema.optional().default(defaultLocale),
    organizerName: organizerNameSchema,
    password: z.string().optional(),
    translationOutputs: z.array(translationOutputModeSchema).optional(),
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionResponseSchema = z
    .object({
        organizerKey: z.string().optional(),
        sessionId: z.string(),
    })
    .passthrough();

export const successResponseSchema = z
    .object({
        success: z.literal(true),
    })
    .passthrough();

export const createSessionFormSchema = z.object({
    durationMinutes: z
        .number()
        .int()
        .min(MIN_SESSION_DURATION_MINUTES)
        .max(MAX_SESSION_DURATION_MINUTES),
    password: z.string(),
    selectedLanguages: z.array(z.string()).min(1),
    translationOutputs: z.array(translationOutputModeSchema).min(1, {
        message: "Select at least one option.",
    }),
});

export type CreateSessionFormValues = z.infer<typeof createSessionFormSchema>;

export const authStatusResponseSchema = z.object({
    passwordRequired: z.boolean(),
});

export const tokenQuerySchema = z.object({
    identity: z.string().min(1),
    organizerKey: z.string().optional(),
    password: z.string().optional(),
    presenterClientId: z.string().optional(),
    role: z.enum(["attendee", "organizer"]).optional().default("attendee"),
    room: z.string().min(1),
});

export const tokenResponseSchema = z.object({
    durationMinutes: z.number().optional(),
    expiresAt: z.string().optional(),
    serverUrl: z.string(),
    token: z.string(),
});

export const translationInfoSchema = z.object({
    language: z.string(),
    status: z.string(),
    subscriberCount: z.number(),
    translatorIdentity: z.string(),
});

export const activeTranslationsResponseSchema = z.object({
    translations: z.array(translationInfoSchema).optional().default([]),
});

export const sessionDetailsResponseSchema = z
    .object({
        allowedLanguages: z.array(z.string()).optional(),
        enableAudioTranslation: z.boolean().optional(),
        enableTranscription: z.boolean().optional(),
    })
    .passthrough();

export const translationRequestSchema = z.object({
    previousLanguage: z.string().optional(),
    sessionId: z.string().min(1),
    targetLanguage: z.string().min(1),
});

export const translationStartResponseSchema = z
    .object({
        translatorIdentity: z.string().nullable().optional(),
    })
    .passthrough();

export const translateStatusQuerySchema = z.object({
    sessionId: z.string().min(1),
});

export const presenterLeaseRequestSchema = z.object({
    clientId: z.string().min(1),
    organizerKey: z.string().min(1),
    takeover: z.boolean().optional(),
});

export const presenterStatusResponseSchema = z.object({
    active: z.boolean(),
    leaseExpiresAt: z.string().optional(),
});

export const deleteSessionRequestSchema = z.object({
    organizerKey: z.string().min(1),
});

export function zodErrorDetails(error: z.ZodError): Record<string, unknown> {
    return {
        issues: error.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            path: issue.path.join("."),
        })),
    };
}
