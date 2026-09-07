/**
 * Real Gemini, simulated LiveKit transport with a clock shared by both controllers.
 * Run: BENCHMARK_PCM_PATH=/path/speech.pcm BENCHMARK_RESULT_PATH=/path/result.json
 * node --env-file=.env.local --import tsx scripts/translation-latency-benchmark.cjs 1800000
 * Consumes two Gemini Live sessions. Does not contact production broadcast participants.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "bpr-latency-benchmark-"));
const pcmPath = process.env.BENCHMARK_PCM_PATH;
if (!pcmPath)
    throw new Error("Set BENCHMARK_PCM_PATH to mono 16kHz signed 16-bit little-endian PCM");
const req = createRequire(root + "/package.json");
const { GeminiLiveConnection } = req(
    root + "/src/lib/translation-bridge/gemini-live-connection.ts",
);
const { TranslatedAudioOutput } = req(
    root + "/src/lib/translation-bridge/translated-audio-output.ts",
);
let original = execFileSync(
    "git",
    [
        "show",
        (process.env.BENCHMARK_BASELINE_REF || "ee9557c") +
            ":src/lib/translation-bridge/translated-audio-output.ts",
    ],
    { encoding: "utf8", cwd: root },
);
original = original
    .replace(
        '"@livekit/rtc-node"',
        JSON.stringify(root + "/node_modules/@livekit/rtc-node/dist/index.cjs"),
    )
    .replace('"../logger"', JSON.stringify(root + "/src/lib/logger.ts"));
fs.writeFileSync(path.join(work, "baseline.ts"), original);
const { TranslatedAudioOutput: Baseline } = req(path.join(work, "baseline.ts"));
const pcm = fs.readFileSync(pcmPath);
if (!pcm.length || pcm.length % 2) throw new Error("PCM must be nonempty and sample aligned");
const durationMs = Number(process.argv[2] || 1800000);
if (!Number.isFinite(durationMs) || durationMs < 1000) throw new Error("Invalid duration");
const langs = ["cs", "de"];
// Both implementations share the same simulated transport clock, independent of frame size.
function mediaClock() {
    const t = performance.now() - started;
    const cycle = Math.floor(t / 300000);
    const phase = t % 300000;
    return cycle * 282000 + Math.min(phase, 240000) + Math.max(0, phase - 240000) * 0.7;
}
class Source {
    constructor() {
        this.end = mediaClock();
        this.publishedMs = 0;
        this.clearCount = 0;
        this.closed = false;
    }
    get queuedDuration() {
        return Math.max(0, this.end - mediaClock());
    }
    async captureFrame(frame) {
        if (this.closed) return;
        const d = (frame.samplesPerChannel / frame.sampleRate) * 1000;
        this.end = Math.max(this.end, mediaClock()) + d;
        this.publishedMs += d;
        while (!this.closed && this.queuedDuration > 300)
            await new Promise((r) =>
                setTimeout(r, Math.min(50, Math.max(1, this.queuedDuration - 300))),
            );
    }
    clearQueue() {
        this.clearCount++;
        this.end = mediaClock();
    }
    async close() {
        this.closed = true;
        this.clearQueue();
    }
}

const cpuStart = process.cpuUsage();
const started = performance.now();
let maxRss = 0;
let stopped = false;
let offset = 0;
let inputMs = 0;
let activeRuns = [];
const buildRuns = () =>
    langs.map((lang) => {
        const oldSource = new Source(),
            newSource = new Source();
        const config = {
            targetLanguage: lang,
            sampleRate: 24000,
            channels: 1,
            maxBacklogMs: 1000,
            targetBacklogMs: 500,
            backlogLogIntervalMs: 5000,
            backlogInfoThresholdMs: 500,
            isClosed: () => stopped,
            onFramePublished: () => {},
        };
        const old = new Baseline(config),
            next = new TranslatedAudioOutput(config);
        old.attach(oldSource);
        next.attach(newSource);
        let frames = 0,
            outputMs = 0,
            text = 0;
        const keys = new Set();
        const backlogOld = [],
            backlogNew = [],
            speeds = [];
        const connection = new GeminiLiveConnection({
            apiKey: process.env.GEMINI_API_KEY,
            model: "gemini-3.5-live-translate-preview",
            targetLanguage: lang,
            enableAudioTranslation: true,
            enableTranscription: true,
            contextCompressionTriggerTokens: 25000,
            contextCompressionTargetTokens: 8000,
            shouldReconnect: () => !stopped,
            onMessage: (msg) => {
                const sc = msg.serverContent;
                if (sc?.outputTranscription) {
                    text++;
                    Object.keys(sc.outputTranscription).forEach((k) => keys.add(k));
                }
                for (const part of sc?.modelTurn?.parts || [])
                    if (part.inlineData?.data) {
                        const b64 = part.inlineData.data;
                        frames++;
                        outputMs += Buffer.from(b64, "base64").length / 48;
                        old.enqueue(b64, Date.now(), frames);
                        next.enqueue(b64, performance.now(), frames);
                    }
            },
        });
        return {
            lang,
            old,
            next,
            oldSource,
            newSource,
            connection,
            backlogOld,
            backlogNew,
            speeds,
            stats: () => ({ frames, outputMs, text, transcriptionKeys: [...keys] }),
        };
    });
function summary(a) {
    const s = [...a].sort((a, b) => a - b);
    return {
        median: s[Math.floor(s.length * 0.5)] ?? null,
        p95: s[Math.floor(s.length * 0.95)] ?? null,
        max: s.at(-1) ?? null,
    };
}
(async () => {
    await req(root + "/src/lib/translation-bridge/audio-tempo.ts").prepareAudioTempo();
    const runs = buildRuns();
    activeRuns = runs;
    await Promise.all(runs.map((r) => r.connection.connect()));
    const send = setInterval(() => {
        if (offset >= pcm.length) offset = 0;
        const chunk = pcm.subarray(offset, offset + 3200);
        offset += chunk.length;
        inputMs += chunk.length / 32;
        for (const r of runs) r.connection.sendAudio(chunk.toString("base64"), 16000);
    }, 100);
    const sample = setInterval(() => {
        maxRss = Math.max(maxRss, process.memoryUsage().rss);
        for (const r of runs) {
            r.backlogOld.push(r.old.getTotalBacklogMs());
            r.backlogNew.push(r.next.getTotalBacklogMs());
            r.speeds.push(r.next.getDiagnostics().playbackSpeed);
        }
        if (runs[0].backlogNew.length % 60 === 0)
            console.log(
                JSON.stringify({
                    event: "soak_progress",
                    elapsedMs: Math.round(performance.now() - started),
                    languages: runs.map((r) => ({
                        lang: r.lang,
                        ...r.stats(),
                        ...r.next.getDiagnostics(),
                    })),
                }),
            );
    }, 1000);
    await new Promise((r) => setTimeout(r, durationMs));
    clearInterval(send);
    clearInterval(sample);
    stopped = true;
    for (const r of runs) {
        r.connection.stop();
        await r.next.close();
        r.old.detach();
    }
    const report = {
        durationMs: Math.round(performance.now() - started),
        inputMs,
        cpuMicroseconds: process.cpuUsage(cpuStart),
        maxRssBytes: maxRss,
        transport:
            "simulated native source 300ms, shared media clock slowed to 70% every fifth minute; no per-frame artificial penalty",
        speech: "provided PCM repeated; identical model output fed to baseline and new controller",
        languages: runs.map((r) => ({
            language: r.lang,
            ...r.stats(),
            baseline: {
                backlog: summary(r.backlogOld),
                publishedMs: r.oldSource.publishedMs,
                droppedMs: r.old.droppedDurationMs,
            },
            updated: {
                backlog: summary(r.backlogNew),
                publishedMs: r.newSource.publishedMs,
                ...r.next.getDiagnostics(),
                speed: summary(r.speeds),
                acceleratedSeconds: r.speeds.filter((s) => s > 1).length,
            },
            input: r.connection.getInputDiagnostics(),
        })),
    };
    fs.writeFileSync(
        process.env.BENCHMARK_RESULT_PATH || path.join(work, "result.json"),
        JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify({ event: "soak_complete", report }));
})().catch(async (e) => {
    stopped = true;
    for (const run of activeRuns) run.connection.stop();
    await Promise.allSettled(activeRuns.map((run) => run.next.close()));
    for (const run of activeRuns) run.old.detach();
    console.error(e.message);
    process.exitCode = 1;
});
