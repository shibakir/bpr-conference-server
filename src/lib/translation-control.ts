import { z } from "zod";

export const translationActionSchema = z.enum(["reset", "drain"]);
export type TranslationAction = z.infer<typeof translationActionSchema>;
export const translationOperationSchema = z.object({
    id: z.string(),
    action: translationActionSchema,
    state: z.enum(["resetting", "draining", "completed", "unconfirmed", "failed"]),
    startedAt: z.number(),
    finishedAt: z.number().optional(),
    error: z
        .enum([
            "timeout",
            "interrupted",
            "output_limit",
            "connection_unavailable",
            "stopped",
            "publication_failed",
        ])
        .optional(),
});
export type TranslationOperation = z.infer<typeof translationOperationSchema>;
export const translationControlSchema = z.object({
    historyRevision: z.number().int().nonnegative(),
    operation: translationOperationSchema.optional(),
});
export type TranslationControl = z.infer<typeof translationControlSchema>;
export const translationControlRequestSchema = z
    .object({
        organizerKey: z.string().min(1),
        requestId: z.string().uuid(),
    })
    .strict();
export const translationControlResponseSchema = z.object({ operation: translationOperationSchema });
export const translationControlsSchema = z.record(z.string(), translationControlSchema);

export function operationIsRunning(operation: TranslationOperation | undefined): boolean {
    return operation?.state === "resetting" || operation?.state === "draining";
}

export class TranslationControlError extends Error {
    constructor(public readonly code: NonNullable<TranslationOperation["error"]>) {
        super(code);
    }
}

export class TranslationActionRequestError extends Error {
    constructor(public readonly code: "inactive" | "conflict" | "rate_limited") {
        super(code);
    }
}
