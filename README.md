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
