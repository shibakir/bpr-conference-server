import { z } from "zod";

const DEFAULT_LIVEKIT_URL = "ws://localhost:7880";

const emptyStringAsUndefined = (value: unknown) => (value === "" ? undefined : value);

const optionalSecretSchema = z.preprocess(
    emptyStringAsUndefined,
    z.string().trim().min(1).optional(),
);

const positiveNumberSchema = z.preprocess(
    emptyStringAsUndefined,
    z.coerce.number().positive().optional(),
);

const liveKitUrlSchema = z.preprocess(
    emptyStringAsUndefined,
    z
        .string()
        .trim()
        .min(1)
        .refine((value) => {
            try {
                const protocol = new URL(value).protocol;
                return ["http:", "https:", "ws:", "wss:"].includes(protocol);
            } catch {
                return false;
            }
        }, "LIVEKIT_URL must be a valid HTTP(S) or WS(S) URL")
        .default(DEFAULT_LIVEKIT_URL),
);

const serverEnvSchema = z.object({
    BROADCAST_PASSWORD: optionalSecretSchema,
    GEMINI_API_KEY: optionalSecretSchema,
    LIVEKIT_API_KEY: optionalSecretSchema,
    LIVEKIT_API_SECRET: optionalSecretSchema,
    LIVEKIT_URL: liveKitUrlSchema,
    TRANSLATION_EMPTY_BRIDGE_GRACE_MS: positiveNumberSchema,
    TRANSLATION_RECONCILE_INTERVAL_MS: positiveNumberSchema,
});

export const serverEnv = serverEnvSchema.parse({
    BROADCAST_PASSWORD: process.env["BROADCAST_PASSWORD"],
    GEMINI_API_KEY: process.env["GEMINI_API_KEY"],
    LIVEKIT_API_KEY: process.env["LIVEKIT_API_KEY"],
    LIVEKIT_API_SECRET: process.env["LIVEKIT_API_SECRET"],
    LIVEKIT_URL: process.env["LIVEKIT_URL"],
    TRANSLATION_EMPTY_BRIDGE_GRACE_MS: process.env["TRANSLATION_EMPTY_BRIDGE_GRACE_MS"],
    TRANSLATION_RECONCILE_INTERVAL_MS: process.env["TRANSLATION_RECONCILE_INTERVAL_MS"],
});
