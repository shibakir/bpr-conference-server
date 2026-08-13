import type { z } from "zod";

export async function readJsonBody(req: Request): Promise<unknown> {
    try {
        return (await req.json()) as unknown;
    } catch {
        return {};
    }
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
    const body: unknown = await response.json();
    return body as T;
}

export async function readValidatedJsonResponse<T>(
    response: Response,
    schema: z.ZodType<T>,
): Promise<T> {
    const body: unknown = await response.json();
    const parsed = schema.safeParse(body);

    if (!parsed.success) {
        throw new Error("Invalid API response");
    }

    return parsed.data;
}

export function parseJson(text: string): unknown {
    return JSON.parse(text) as unknown;
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
    const body = await readJsonBody(req);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return {};
    }

    return body as Record<string, unknown>;
}

export async function parseJsonRequest<T>(req: Request, schema: z.ZodType<T>) {
    const body = await readJsonBody(req);
    return schema.safeParse(body);
}

export function parseSearchParams<T>(searchParams: URLSearchParams, schema: z.ZodType<T>) {
    return schema.safeParse(Object.fromEntries(searchParams));
}
