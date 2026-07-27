# Atlas Browser

Electron and TypeScript browser MVP that uses Chromium's `webview` for navigation.

## Run

```powershell
npm install
npm start
```

## Included

- Tabs, address/search bar, back, forward, and reload controls
- Local bookmarks and history stored in Electron's user-data directory
- Page heading outline and clickable SVG link graph built from indexed pages
- SQLite FTS5 local index with `AND`, `OR`, `NOT`, parentheses, and phrase search
- Selected-text knowledge notes with personal annotations, tags, unified search, and graph links
- Keyboard shortcuts: `Ctrl+L` address bar and `Ctrl+T` new tab
