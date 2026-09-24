# Productivity Timer (PWA)

Pomodoro + countdown + stopwatch with a task list and per-task time tracking.
Pure HTML/CSS/JS, no build step, no server-side code. All data is saved in the browser's localStorage.

## Files
- `index.html`: app markup, with all the styles inlined in a `<style>` block so the page renders without waiting for a stylesheet
- `css/app.css`: the readable source of the styles. The page doesn't load it directly; the same CSS is copied into the `<style>` block of `index.html`. If you edit styles, edit both (or paste app.css into the `<style>` block).
- `js/app.js`: all app logic
- `sw.js`: service worker (offline cache)
- `manifest.webmanifest`: install settings (full screen, any orientation)
- `icons/`: app icons

## Run locally
```
cd "Productivity Timer"
python3 -m http.server 8080
```
Open http://localhost:8080. Service workers need `http://localhost` or HTTPS. They won't run from `file://`.

## Install on a phone
1. Host the folder on any HTTPS static host, for example GitHub Pages, Netlify Drop or Cloudflare Pages. A subfolder on your own domain also works.
2. Open the URL on the phone.
   - **Android (Chrome):** menu → *Install app*. The app opens full screen.
   - **iPhone (Safari):** Share → *Add to Home Screen*. iOS opens it full screen apart from the status bar.

## Updating
After you change any file, bump `VERSION` in `sw.js` (for example `ptimer-v2`) so installed copies pick up the new files. If you change `js/app.js`, also bump the `?v=` number on its `<script>` tag in `index.html` and in `sw.js`, so Cloudflare serves the new file.

## Shortcuts (keyboard)
Space start/pause · R reset · L lap · 1–4 switch tabs · F full screen · Z focus mode · Esc close

## Appearance
- Theme: Auto (follows the device's light/dark setting), Light or Dark. The sun/moon button in the top bar switches it; Settings → Appearance has all three options.
- Default colours are Mono: black and greys in light mode, white and greys in dark mode. Settings → Appearance also has preset palettes and a colour picker for each mode (Focus, Short, Long, Timer, Stopwatch).

## Notes
- The timers store an end time, not a running counter. The time stays correct after a reload, a switch to another tab or when the screen is off.
- Mobile browsers pause web apps in the background. If the timer ends while the app is closed, the alarm plays the next time you open it. "Keep screen on" (on by default) avoids this during a session. The screen also stays on whenever the app is in full screen or opened as an installed app, even with no timer running. You can turn this off in Settings.
- Settings → Export/Import saves your tasks and history to a JSON file as a backup.
