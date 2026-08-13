export const MIN_SESSION_DURATION_MINUTES = 1;
export const MAX_SESSION_DURATION_MINUTES = 12 * 60;
export const DEFAULT_SESSION_DURATION_MINUTES = 60;

export const SESSION_DURATION_OPTIONS_MINUTES = [
    5,
    15,
    30,
    45,
    60,
    90,
    120,
    180,
    240,
    360,
    480,
    MAX_SESSION_DURATION_MINUTES,
] as const;

export function parseSessionDurationMinutes(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") {
        return DEFAULT_SESSION_DURATION_MINUTES;
    }

    const duration =
        typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;

    if (
        !Number.isInteger(duration) ||
        duration < MIN_SESSION_DURATION_MINUTES ||
        duration > MAX_SESSION_DURATION_MINUTES
    ) {
        return undefined;
    }

    return duration;
}

export function formatRemainingSessionTime(remainingMs: number): string {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatDurationPart(value: number, unit: "hour" | "minute", locale?: string): string {
    return new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "short",
    }).format(value);
}

export function formatSessionDurationLabel(durationMinutes: number, locale?: string): string {
    const normalizedDurationMinutes = Math.max(
        MIN_SESSION_DURATION_MINUTES,
        Math.round(durationMinutes),
    );
    const hours = Math.floor(normalizedDurationMinutes / 60);
    const minutes = normalizedDurationMinutes % 60;

    if (hours === 0) {
        return formatDurationPart(minutes, "minute", locale);
    }

    if (minutes === 0) {
        return formatDurationPart(hours, "hour", locale);
    }

    return `${formatDurationPart(hours, "hour", locale)} ${formatDurationPart(
        minutes,
        "minute",
        locale,
    )}`;
}
