export function parseCaptionLanguages(value: unknown): string[] {
    if (typeof value !== "string") return [];

    return value
        .split(",")
        .map((language) => language.trim())
        .filter(Boolean);
}

export function participantWantsTranslation(
    participantAttributes: Record<string, string> | undefined,
    targetLanguage: string,
): boolean {
    return (
        participantAttributes?.["language"] === targetLanguage ||
        parseCaptionLanguages(participantAttributes?.["captionLanguages"]).includes(targetLanguage)
    );
}
