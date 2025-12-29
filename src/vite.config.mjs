import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname for ESM
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Enable modern output so top-level await in src/main.mjs is supported
// Set base to './' so production assets work when loaded via file:// in Electron
export default defineConfig({
  base: './',
  build: {
    target: 'esnext'
  },
  server: {
    port: 5173,
    strictPort: true,
    // Serve files under "/data" directly from the local data/ folder during dev
    configureServer(server) {
      const dataDir = path.resolve(__dirname, 'data');
      server.middlewares.use('/data', (req, res, next) => {
        try {
          const urlPath = (req.url || '/').split('?')[0];
          // strip leading '/data' and any leading slashes
          const rel = urlPath.replace(/^\/+/, '').replace(/^data\/?/, '');
          const filePath = path.join(dataDir, rel);
          fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) return next();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/octet-stream');
            const stream = fs.createReadStream(filePath);
            stream.on('error', next);
            stream.pipe(res);
          });
        } catch (e) {
          next();
        }
      });
    }
  }
});
