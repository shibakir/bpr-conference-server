import path from "node:path";

import pino from "pino";

const isTestRuntime = process.env["VITEST"] === "true" || process.env["NODE_ENV"] === "test";

function createLogStreams(): pino.StreamEntry[] {
    const streams: pino.StreamEntry[] = [{ stream: process.stdout }];

    if (isTestRuntime) {
        return streams;
    }

    try {
        streams.push({
            stream: pino.destination({
                dest: process.env["LOG_FILE_PATH"] ?? path.join(process.cwd(), "logs", "app.log"),
                mkdir: true,
                sync: false,
            }),
        });
    } catch (error) {
        process.stderr.write(
            `[Logger] Failed to initialize file logging: ${
                error instanceof Error ? error.message : String(error)
            }\n`,
        );
    }

    return streams;
}

export const logger = pino(
    {
        level: isTestRuntime ? "silent" : (process.env["LOG_LEVEL"] ?? "info"),
        name: "bpr-conference-server",
        redact: {
            censor: "[Redacted]",
            paths: [
                "*.apiKey",
                "*.apiSecret",
                "*.password",
                "*.token",
                "apiKey",
                "apiSecret",
                "password",
                "token",
            ],
        },
        serializers: {
            err: pino.stdSerializers.err,
        },
        timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(createLogStreams()),
);

export function createLogger(bindings: Record<string, unknown>) {
    return logger.child(bindings);
}

export function registerServerLogger() {
    logger.debug("Server logger initialized");
}
