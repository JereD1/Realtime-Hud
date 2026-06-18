# Health Capture — Electron App

Detects when a player's health bar goes white/null in any game or app window, then automatically fires a POST to your scoreboard endpoint to trigger the player fade.

## Setup

```bash
npm install
npm start
```

## How it works

1. **Select window** — picks up all open windows via Electron's `desktopCapturer`
2. **Draw region** — a transparent overlay lets you click-drag over the health bar
3. **Map to player** — assign the region to a team + player slot
4. **Configure** — set white threshold, poll rate, endpoint URL
5. **Start capture** — polls the region every N ms, detects when it goes white, POSTs to your scoreboard

## Detection logic

Every poll frame:
- The source window thumbnail is captured
- The selected region is cropped out
- Every pixel is checked: if R, G, B are all ≥ `whiteThreshold` it counts as "white"
- If >70% of region pixels are white → health is null → kill is triggered

## Scoreboard endpoint

Sends a POST to your Next.js endpoint:

```json
{
  "team1AliveStatus": [true, true, false, true, true],
  "team2AliveStatus": [true, true, true, true, true]
}
```

Default: `http://localhost:3000/api/pusher/scoreboard`

## Settings

| Setting | Default | Description |
|---|---|---|
| White threshold | 210 | Pixel brightness to count as "white" (0–255) |
| Poll rate | 120ms | How often the region is sampled |
| Team size | 5 | Number of player slots per team |

## Permissions (macOS)

On macOS you'll need to grant **Screen Recording** permission to Electron in System Settings → Privacy & Security → Screen Recording.

## Multi-player setup

Run one region per player health bar by launching the app and setting up each region sequentially — each one posts independently to the same endpoint. Or clone the project and run multiple instances pointed at different player slots.
