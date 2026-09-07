import { z } from "zod";

export const OUTPUT_BACKLOG_OPTIONS_MS = [1000, 2000, 3000, 5000] as const;
export const INPUT_FRAME_OPTIONS_MS = [50, 100, 200] as const;

export const translationSettingsSchema = z.object({
    maxOutputBacklogMs: z.union([
        z.literal(1000),
        z.literal(2000),
        z.literal(3000),
        z.literal(5000),
    ]),
    inputFrameSizeMs: z.union([z.literal(50), z.literal(100), z.literal(200)]),
});
export type TranslationSettings = z.infer<typeof translationSettingsSchema>;
export type TranslationSettingsSnapshot = TranslationSettings & { version: number };

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettingsSnapshot = {
    maxOutputBacklogMs: 1000,
    inputFrameSizeMs: 100,
    version: 1,
};

export const updateTranslationSettingsSchema = translationSettingsSchema
    .extend({
        organizerKey: z.string().min(1),
        expectedVersion: z.number().int().positive(),
    })
    .strict();

export const translationSettingsSnapshotSchema = translationSettingsSchema.extend({
    version: z.number().int().positive(),
});
