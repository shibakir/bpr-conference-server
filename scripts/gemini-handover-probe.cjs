/** Isolated provider check; never joins LiveKit or writes to a production broadcast.
 * Input: test mono 16kHz signed 16-bit little-endian PCM (looped).
 * node --env-file=.env.local --import tsx scripts/gemini-handover-probe.cjs INPUT warm OUTPUT.json 600000
 * Handover timings are production defaults unless HANDOVER_PROBE_START_AGE_MS is set.
 * This records server text only. It is not an end-to-end broadcast pilot.
 */
const fs = require("node:fs");
const { GeminiLiveConnection } = require("../src/lib/translation-bridge/gemini-live-connection.ts");
const {
    GeminiSessionCoordinator,
    WARM_HANDOVER_DEFAULTS,
} = require("../src/lib/translation-bridge/gemini-session-coordinator.ts");
const [input, mode = "warm", output, durationArg = "600000"] = process.argv.slice(2);
if (!input || !output || !["warm", "legacy"].includes(mode))
    throw new Error("Provide INPUT.pcm warm|legacy OUTPUT.json [durationMs]");
if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required");
const pcm = fs.readFileSync(input);
if (!pcm.length || pcm.length % 2) throw new Error("Input must contain sample-aligned PCM");
const durationMs = Number(durationArg);
const startAgeMs = Number(
    process.env.HANDOVER_PROBE_START_AGE_MS || WARM_HANDOVER_DEFAULTS.standbyStartAgeMs,
);
if (
    !Number.isFinite(durationMs) ||
    durationMs < 1000 ||
    !Number.isFinite(startAgeMs) ||
    startAgeMs < 1000
)
    throw new Error("Invalid timing");
const started = performance.now();
const events = [];
const handovers = [];
let stopped = false;
let lastTextAt = null;
let waitingHandover = null;
let lostInputMs = 0;
let failed = false;
let sourceStartedAt = null;
let offset = 0;
const options = {
    apiKey: process.env.GEMINI_API_KEY,
    sessionId: "isolated-handover-probe",
    model: "gemini-3.5-live-translate-preview",
    targetLanguage: "cs",
    enableAudioTranslation: process.env.HANDOVER_PROBE_AUDIO === "true",
    enableTranscription: true,
    contextCompressionTriggerTokens: 25000,
    contextCompressionTargetTokens: 8000,
    shouldReconnect: () => !stopped,
    onMessage(message) {
        const content = message.serverContent || {};
        const text =
            (content.outputTranscription || message.outputTranscription)?.text ||
            content.modelTurn?.parts?.map((p) => p.text || "").join("") ||
            "";
        if (!text.trim()) return;
        const ms = performance.now() - started;
        if (waitingHandover) {
            waitingHandover.firstNewTextReceivedAt = ms;
            waitingHandover.serverTextGapMs = lastTextAt === null ? null : ms - lastTextAt;
            waitingHandover = null;
        }
        lastTextAt = ms;
        events.push({
            ms,
            sourceMs: sourceStartedAt === null ? null : performance.now() - sourceStartedAt,
            text,
        });
    },
    timings: { standbyStartAgeMs: startAgeMs },
    onHandover() {
        waitingHandover = {
            committedAt: performance.now() - started,
            lastActiveTextReceivedAt: lastTextAt,
        };
        handovers.push(waitingHandover);
        return { discardedPendingCaptionChars: 0 };
    },
};
const connection =
    mode === "warm" ? new GeminiSessionCoordinator(options) : new GeminiLiveConnection(options);
process.once("SIGINT", () => {
    stopped = true;
    connection.stop();
});
process.once("SIGTERM", () => {
    stopped = true;
    connection.stop();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
    try {
        await connection.connect();
        sourceStartedAt = performance.now();
        let nextPacketAt = sourceStartedAt;
        const end = sourceStartedAt + durationMs;
        while (!stopped && performance.now() < end) {
            await sleep(Math.max(0, nextPacketAt - performance.now()));
            if (stopped) break;
            // Skip stale source intervals instead of sending a catch-up burst to Gemini.
            const missed = Math.floor((performance.now() - nextPacketAt) / 100);
            if (missed > 0) {
                lostInputMs += missed * 100;
                connection.recordDroppedInput(missed * 100);
                offset = (offset + missed * 3200) % pcm.length;
                nextPacketAt += missed * 100;
            }
            const packet = Buffer.alloc(3200);
            let written = 0;
            while (written < packet.length) {
                const count = Math.min(packet.length - written, pcm.length - offset);
                pcm.copy(packet, written, offset, offset + count);
                offset = (offset + count) % pcm.length;
                written += count;
            }
            connection.sendAudio(packet.toString("base64"), 16000);
            nextPacketAt += 100;
        }
    } catch {
        failed = true;
        process.exitCode = 1;
        console.error("Isolated provider probe failed; no credentials logged");
    } finally {
        const diagnostics = connection.getInputDiagnostics();
        stopped = true;
        connection.stop();
        await connection.waitForRetired();
        const result = {
            mode,
            failed,
            durationMs,
            elapsedMs: performance.now() - started,
            startAgeMs,
            warmupMs: WARM_HANDOVER_DEFAULTS.warmupMs,
            audioEnabled: options.enableAudioTranslation,
            sourceDurationMs: pcm.length / 32,
            lostInputMs,
            diagnostics,
            handovers,
            events,
        };
        fs.writeFileSync(output, JSON.stringify(result, null, 2));
        console.log(
            JSON.stringify({
                output,
                failed,
                receivedTextEvents: events.length,
                handovers,
                diagnostics,
            }),
        );
    }
})();
