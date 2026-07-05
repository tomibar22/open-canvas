# Open Canvas

An infinite, calm, open-world canvas for structural thinking — like Apple Freeform, but with grid intelligence built in. Place circles and squares on an endless canvas; they magnetize to each other, spacing equalizes itself, and structure emerges from what you place.

**Stage 1** (current): infinite pan/zoom canvas, place/toggle/drag elements, smart snapping (center/edge alignment + equal-spacing with live guides), multi-select, groups (redistribute, change count across a fixed span, duplicate-below, ungroup), an in-memory asset library, a pages sidebar, and undo/redo.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
```

## Build

```bash
npm run build    # outputs to dist/
npm run preview
```

## Deploy

Pushing to `main` builds and publishes to GitHub Pages automatically via `.github/workflows/deploy.yml`. Enable it once under **Settings → Pages → Source: GitHub Actions**.

## Tech

Single-file React app (`src/App.jsx`), Vite, SVG rendering, Pointer Events throughout. No persistence yet — all state lives in React memory (JSON export/import arrives in Stage 2).

## Gestures

| Input | On an element | On empty canvas |
|---|---|---|
| Tap | toggle state (empty ↔ filled) | deselect / place (with tool armed) |
| Drag | move (with snapping) | pan |
| Long-press | select (multi-select) | — |
| Two fingers | pan / pinch-zoom | pan / pinch-zoom |
| Double-tap | — | zoom to fit content |

Shortcuts: `Cmd/Ctrl+Z` undo, `Shift+Cmd/Ctrl+Z` redo, `Cmd/Ctrl+D` duplicate, `Cmd/Ctrl+G` group, `Delete`/`Backspace` remove.
