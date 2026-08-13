import { serverEnv } from "../env/server";

type PositiveNumberEnvName =
    "TRANSLATION_EMPTY_BRIDGE_GRACE_MS" | "TRANSLATION_RECONCILE_INTERVAL_MS";

export function getBroadcastPassword() {
    return serverEnv.BROADCAST_PASSWORD;
}

export function getGeminiApiKey() {
    return serverEnv.GEMINI_API_KEY;
}

export function getLiveKitUrl() {
    return serverEnv.LIVEKIT_URL;
}

export function getLiveKitCredentials() {
    const apiKey = serverEnv.LIVEKIT_API_KEY;
    const apiSecret = serverEnv.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
        return null;
    }

    return { apiKey, apiSecret };
}

export function getPositiveNumberEnv(name: PositiveNumberEnvName, fallback: number) {
    return serverEnv[name] ?? fallback;
}
