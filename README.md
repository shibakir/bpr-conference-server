# BPR Conference Server

Nest API for the BPR Conference realtime translation app.

## Setup

```bash
npm install
```

Create `.env.local`:

```env
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_URL=ws://localhost:7880
GEMINI_API_KEY=your-gemini-api-key-here
BROADCAST_PASSWORD=optional-secure-password
NEXT_PUBLIC_ATTENDEE_ORIGIN=http://localhost:3000
```

## Development

```bash
npm run dev
```

The API listens on `API_PORT` or `3001` by default.

## Production

```bash
npm run build
npm start
```

## Deploy

See [EC2 Docker deploy](docs/ec2-docker-deploy.md).

## Translation settings

New sessions use the `balanced` preset. The owner can read settings with
`GET /api/sessions/:sessionId/translation-settings` and the `x-organizer-key` header.
PATCH the same endpoint with `organizerKey`, `expectedVersion`,
`maxOutputBacklogMs`, `inputFrameSizeMs`, and an optional `preset`.

| Preset               | Maximum output queue         | Input audio chunk       |
| -------------------- | ---------------------------- | ----------------------- |
| `balanced` (default) | 2000 ms                      | 100 ms                  |
| `speed`              | 1000 ms                      | 50 ms                   |
| `quality`            | 5000 ms                      | 100 ms                  |
| `poorConnection`     | 3000 ms                      | 300 ms                  |
| `manual`             | 1000 / 2000 / 3000 / 5000 ms | 50 / 100 / 200 / 300 ms |

Named presets must match their numeric values. Older requests without a preset
are saved as manual settings. Mode-only changes also increment the settings version.
Settings apply to current and future translation bridges in the session. Sessions
and settings are held in memory and do not survive a server restart.

The quality preset allows more speech to queue before dropping it; it does not
change the translation model. The poor connection preset sends fewer, larger
messages to Gemini at the cost of input waiting time. It does not repair network
dropouts. The output queue limit excludes model processing and listener delivery.
