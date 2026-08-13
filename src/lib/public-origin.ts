export function normalizeOrigin(origin: string | undefined) {
    return origin?.trim().replace(/\/+$/, "") ?? "";
}

export function getConfiguredAttendeeOrigin() {
    const origin = normalizeOrigin(process.env.NEXT_PUBLIC_ATTENDEE_ORIGIN);
    if (!origin) return "";

    try {
        new URL(origin);
        return origin;
    } catch {
        return "";
    }
}
