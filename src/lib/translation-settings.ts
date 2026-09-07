import { z } from "zod";

export const OUTPUT_BACKLOG_OPTIONS_MS = [1000, 2000, 3000, 5000] as const;
export const INPUT_FRAME_OPTIONS_MS = [50, 100, 200, 300] as const;
export const TRANSLATION_PRESET_OPTIONS = [
    "balanced",
    "speed",
    "quality",
    "poorConnection",
    "manual",
] as const;
export const translationPresetSchema = z.enum(TRANSLATION_PRESET_OPTIONS);
export type TranslationPreset = z.infer<typeof translationPresetSchema>;

export const translationSettingsSchema = z.object({
    maxOutputBacklogMs: z.union([
        z.literal(1000),
        z.literal(2000),
        z.literal(3000),
        z.literal(5000),
    ]),
    inputFrameSizeMs: z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(300)]),
});
export type TranslationSettings = z.infer<typeof translationSettingsSchema>;

export const TRANSLATION_PRESETS = {
    balanced: { maxOutputBacklogMs: 2000, inputFrameSizeMs: 100 },
    speed: { maxOutputBacklogMs: 1000, inputFrameSizeMs: 50 },
    quality: { maxOutputBacklogMs: 5000, inputFrameSizeMs: 100 },
    poorConnection: { maxOutputBacklogMs: 3000, inputFrameSizeMs: 300 },
} as const satisfies Record<Exclude<TranslationPreset, "manual">, TranslationSettings>;

export const translationSettingsSnapshotSchema = translationSettingsSchema.extend({
    version: z.number().int().positive(),
    // Optional when reading responses from servers deployed before presets were introduced.
    preset: translationPresetSchema.optional(),
});
export type TranslationSettingsSnapshot = z.infer<typeof translationSettingsSnapshotSchema>;

export function getTranslationPreset(
    settings: TranslationSettings & { preset?: TranslationPreset | undefined },
): TranslationPreset {
    return settings.preset ?? "manual";
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettingsSnapshot = {
    ...TRANSLATION_PRESETS.balanced,
    preset: "balanced",
    version: 1,
};

export const updateTranslationSettingsSchema = translationSettingsSchema
    .extend({
        organizerKey: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        // Existing clients send just the two numeric settings and enter manual mode.
        preset: translationPresetSchema.optional(),
    })
    .strict()
    .superRefine((settings, context) => {
        if (!settings.preset || settings.preset === "manual") return;
        const preset = TRANSLATION_PRESETS[settings.preset];
        if (
            settings.maxOutputBacklogMs !== preset.maxOutputBacklogMs ||
            settings.inputFrameSizeMs !== preset.inputFrameSizeMs
        ) {
            context.addIssue({
                code: "custom",
                path: ["preset"],
                message: "Settings do not match the selected preset",
            });
        }
    });
