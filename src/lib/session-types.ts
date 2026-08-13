export const TRANSLATION_OUTPUT_MODES = ["audio", "text"] as const;

export type TranslationOutputMode = (typeof TRANSLATION_OUTPUT_MODES)[number];

export function isTranslationOutputMode(value: unknown): value is TranslationOutputMode {
    return (
        typeof value === "string" &&
        TRANSLATION_OUTPUT_MODES.includes(value as TranslationOutputMode)
    );
}
