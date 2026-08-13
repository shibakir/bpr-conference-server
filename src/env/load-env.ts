import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_FILES = [".env", ".env.local"];

function parseEnvLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) return null;

    const key = match[1];
    if (!key) return null;

    const rawValue = match[2] ?? "";
    let value = rawValue.trim();

    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1);
    }

    return { key, value };
}

export function loadEnvFiles(cwd: string) {
    for (const envFile of ENV_FILES) {
        const path = resolve(cwd, envFile);
        if (!existsSync(path)) continue;

        const contents = readFileSync(path, "utf8");
        for (const line of contents.split(/\r?\n/)) {
            const parsed = parseEnvLine(line);
            if (!parsed || process.env[parsed.key] !== undefined) continue;

            process.env[parsed.key] = parsed.value;
        }
    }
}
