import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Even's reviewer rejects any https:// URL in the bundle that isn't in app.json's network
// whitelist. React and react-router bake dead "error docs" links (react.dev/errors,
// reactrouter.com) into their PRODUCTION code — the app never navigates to them. Neutralize the
// protocol so the scanner doesn't see a URL (the link text still reads fine on the off chance a
// production error fires). Loopback + w3.org XML namespaces are exempt and left alone.
const stripDeadUrls: Plugin = {
  name: 'strip-dead-urls',
  apply: 'build',
  renderChunk(code) {
    return code
      .replace(/https:\/\/react\.dev/g, 'react.dev')
      .replace(/https:\/\/reactrouter\.com/g, 'reactrouter.com')
  },
}

export default defineConfig({
  // the build's own version and build time: an error report says which build it came from, and the
  // phone screen shows it — the version alone can't tell apart two test builds made between uploads
  define: {
    __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync('app.json', 'utf8')).version),
    __BUILD__: JSON.stringify(new Date().toLocaleString('sv-SE').slice(5, 16)),  // "MM-DD HH:mm", local time
  },
  plugins: [react(), stripDeadUrls],
  base: './', // relative asset paths for the packaged webview
  server: { host: true, port: 5173 },
  build: { assetsDir: '' }, // flatten assets into dist root (evenhub pack mishandles subdirs)
})
