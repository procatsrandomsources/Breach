# Breach Protocol — Multiplayer

Browser FPS (Three.js) with Photon Realtime multiplayer: lobby codes, quick match,
real-time player sync, bot fill, and voice chat.

## Files

- `Breach_Protocol_v11_Oregon (6).html` — the game (single-file Three.js app)
- `net.js` — multiplayer layer (Photon Realtime + WebRTC voice signaling)
- `photon.min.js` — vendored Photon Realtime JS SDK (works offline / any host)

## Run locally

Any static file server works (needed for WebSockets + mic):

```
cd "C:\Users\proca\Downloads\Breach"
python -m http.server 8741
# or: npx serve .
```

Open `http://localhost:8741/Breach_Protocol_v11_Oregon%20(6).html`

## Photon setup

1. Create a free account at https://dashboard.photonengine.com
2. Create a **Photon Realtime** (or "Photon JavaScript") app — copy its **App ID**
3. Put the App ID in `net.js` at the top: `const APPID = '...'`
4. The region auto-tries `eu`, `us`, `asia` (change `REGIONS` if needed)

> Never commit a real secret. The App ID is public-by-design for client games,
but keep private keys out of the repo.

## Play

- Menu → **Multiplayer** → **Connect** → **Quick match** (fills/creates a room)
  or **Host game** (share the 5-letter room code) → **Join** with the code.
- Host picks the map and presses **Start match**. Players deploy when ready.
- Attackers breach walls/barricades/hatches and defuse the device.
  Defenders hold the building. Bots fill each side up to 4 combatants.
- First to 4 rounds wins (6 rounds max).
- **Chat:** `Enter` to type, `Enter` to send, `Esc` to cancel.
- **Voice:** press `N` or the MIC button (mic permission required; works on
  localhost/HTTPS). Voice uses WebRTC mesh signaled through Photon room events,
  so the single Realtime App ID is enough — no separate Voice App ID needed.

## GitHub Pages

Push the folder to a repo and enable Pages — Photon WSS + WebRTC voice work
over HTTPS. `file://` will NOT work.
