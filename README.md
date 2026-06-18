# Realtime HUD - Electron App

Detects when a player card fades or greys out, then marks that player as dead and posts the updated alive status to your scoreboard endpoint.

## Setup

```bash
npm install
npm start
```

## How it works

1. Select the game, stream, or screen source.
2. Capture a frame.
3. Drag one box around the full row of five player cards.
4. Start detection.
5. The app splits that selected row into five equal card regions and watches each card for fade.

## Detection logic

Every poll frame:

- The selected source is captured as an image.
- The selected card row is split into five player cards.
- Each card is measured for saturation, contrast, brightness, and grey-pixel ratio.
- A player is marked dead when the card becomes washed out and low color, like a faded death card.

This is intended for UI states where death is shown by the player card fading, not by the health bar turning white.

## Scoreboard endpoint

Sends a POST to your Next.js endpoint:

```json
{
  "team1AliveStatus": [true, true, true, true, false],
  "team2AliveStatus": [true, true, true, true, true]
}
```

Default: `http://localhost:3000/api/pusher/scoreboard`

## Settings

| Setting | Default | Description |
|---|---:|---|
| Fade sensitivity | 0.62 | Lower catches weaker fades; higher requires stronger grey fade |
| Poll rate | 160ms | How often the source is sampled |
| Team size | 5 | Number of player card slots in the selected row |

## Calibration

Draw the selection around the portrait/card area for all five players, not the weapon or lower HUD area. The detector works best when the row includes the visible card art that fades on death.

## Permissions

On macOS, grant Screen Recording permission to Electron in System Settings -> Privacy & Security -> Screen Recording.
