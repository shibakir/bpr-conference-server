/** Isolated real-provider probe. No LiveKit rooms or broadcast participants are contacted.
 * node --env-file=.env.local --import tsx scripts/translation-drain-probe.cjs /tmp/speech.pcm
 * Input: synthetic/test mono 16kHz signed 16-bit PCM. Uses two short streams in one session.
 */
const fs = require("node:fs");
const { GeminiLiveConnection } = require("../src/lib/translation-bridge/gemini-live-connection.ts");
const pcm = fs.readFileSync(process.argv[2]);
const mode = process.argv[3] || "both";
const output = process.argv[4] || "/tmp/bpr-translation-drain-probe.json";
const silenceMs = Number(process.argv[5] || 0);
if (!pcm.length || pcm.length % 2) throw new Error("Input must contain nonempty 16-bit PCM");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = performance.now();
let phase = "setup";
const events = [];
const audio = [];
const connection = new GeminiLiveConnection({
    apiKey: process.env.GEMINI_API_KEY,
    model: "gemini-3.5-live-translate-preview",
    targetLanguage: "cs",
    enableAudioTranslation: mode !== "text",
    enableTranscription: mode !== "audio",
    contextCompressionTriggerTokens: 25000,
    contextCompressionTargetTokens: 8000,
    shouldReconnect: () => true,
    onMessage(message) {
        const content = message.serverContent || {};
        const parts = content.modelTurn?.parts || [];
        const transcript = content.outputTranscription || message.outputTranscription;
        const buffers = parts
            .filter((p) => p.inlineData?.data)
            .map((p) => Buffer.from(p.inlineData.data, "base64"));
        audio.push(...buffers);
        events.push({
            ms: Math.round(performance.now() - started),
            phase,
            text: transcript?.text || parts.map((p) => p.text || "").join(""),
            finished: transcript?.finished,
            turnComplete: content.turnComplete,
            generationComplete: content.generationComplete,
            interrupted: content.interrupted,
            audioMs: buffers.reduce((n, b) => n + b.length / 48, 0),
        });
    },
});
(async () => {
    try {
        await connection.connect();
        for (let pass = 1; pass <= 2; pass++) {
            phase = `input-${pass}`;
            for (let offset = 0; offset < pcm.length; offset += 3200) {
                connection.sendAudio(pcm.subarray(offset, offset + 3200).toString("base64"), 16000);
                await sleep(100);
            }
            phase = `drain-${pass}`;
            for (let ms = 0; ms < silenceMs; ms += 100) {
                connection.sendAudio(Buffer.alloc(3200).toString("base64"), 16000);
                await sleep(100);
            }
            if (!connection.endAudioInput()) throw new Error("Stream end was not sent");
            events.push({
                ms: Math.round(performance.now() - started),
                phase,
                signal: "audioStreamEnd",
            });
            await sleep(12000);
        }
        fs.writeFileSync(output, JSON.stringify({ mode, silenceMs, events }, null, 2));
        fs.writeFileSync(output + ".pcm", Buffer.concat(audio));
        console.log(
            JSON.stringify({
                output,
                mode,
                markers: events.filter((e) => e.turnComplete || e.generationComplete || e.finished),
                text: events.map((e) => e.text || "").join(""),
            }),
        );
    } finally {
        connection.stop();
    }
})().catch(() => {
    console.error("Provider probe failed; no credentials logged");
    process.exitCode = 1;
});
