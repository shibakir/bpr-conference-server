import "reflect-metadata";

import { loadEnvFiles } from "./env/load-env";

loadEnvFiles(process.cwd());

const DEFAULT_API_PORT = 3001;

function getApiPort() {
    const rawPort = process.env["API_PORT"];
    if (!rawPort) return DEFAULT_API_PORT;

    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("API_PORT must be an integer between 1 and 65535");
    }

    return port;
}

async function bootstrap() {
    const [{ NestFactory }, { AppModule }, { createLogger }] = await Promise.all([
        import("@nestjs/core"),
        import("./app.module.js"),
        import("./lib/logger.js"),
    ]);
    const log = createLogger({ service: "nest-api" });
    const app = await NestFactory.create(AppModule, { logger: false });
    const port = getApiPort();

    app.enableShutdownHooks();

    await app.listen(port, "0.0.0.0");
    log.info({ port }, "Nest API server started");
}

void bootstrap().catch((error) => {
    process.stderr.write(
        `[Nest API] Failed to start: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exit(1);
});
