# Demo vault and README screenshots

The images in `docs/images/` are generated, so they can be retaken after UI
changes. Run from the repo root:

```sh
npm run build
DEMO=/tmp/acr-demo                       # any scratch directory
node scripts/demo/vault.mjs create "$DEMO/Notes"

# A separate Obsidian profile, so your own vaults and settings are untouched.
mkdir -p "$DEMO/profile"
echo "{\"vaults\":{\"acrdemo000000001\":{\"path\":\"$DEMO/Notes\",\"ts\":0,\"open\":true}}}" > "$DEMO/profile/obsidian.json"
obsidian --user-data-dir="$DEMO/profile" --remote-debugging-port=9333 &

# In Obsidian: trust the vault if asked. For an English UI:
node scripts/demo/cdp.mjs eval 'localStorage.setItem("language","en"); location.reload()'

# Once the plugin has adopted the notes, let the "agent" edit them on disk:
node scripts/demo/vault.mjs agent "$DEMO/Notes"
node scripts/demo/screenshots.mjs docs/images
```

`cdp.mjs` is a tiny DevTools client (`eval`, `shot`, `size`) for poking at the
running app. Real mouse movement over the window is ignored while the
screenshot script runs, so it can't open stray hover bubbles.
