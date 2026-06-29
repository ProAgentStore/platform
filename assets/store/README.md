# PAGS Store Assets

HTML files in this directory are source templates for App Store screenshots. Render at `1290x2796` for 6.9-inch iPhone screenshots.

```bash
cd platform/assets/store
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless --disable-gpu --hide-scrollbars --window-size=1290,2796 \
  --screenshot=screenshot-1-chat.png screenshot-1-chat.html
```

Required final iOS screenshots:
- `screenshot-1-chat.png`
- `screenshot-2-board.png`
- `screenshot-3-coder.png`
- `screenshot-4-settings.png`

Use real simulator screenshots before final submission if the app state can be seeded reliably.
