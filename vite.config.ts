import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';
import { execSync, execFileSync } from 'child_process';
import type { ServerResponse } from 'http';

// Resolve python binary: prefer venv, fall back to python3/python
const PYTHON = fs.existsSync(path.join(__dirname, 'venv/bin/python'))
  ? path.join(__dirname, 'venv/bin/python')
  : 'python3';

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

function formatError(err: any): string {
  return err.stderr?.toString().slice(0, 500) || err.message;
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    {
      name: 'serve-data-exports',
      configureServer(server) {
        // POST /api/salesforce/refresh — re-sync SF data then rebuild competitor tracker
        server.middlewares.use('/api/salesforce/refresh', (req, res, next) => {
          if (req.method !== 'POST') return next();

          const start = Date.now();
          const elapsed = () => `${((Date.now() - start) / 1000).toFixed(1)}s`;

          try {
            execSync(`${PYTHON} -m src.exports.export_salesforce`, {
              cwd: __dirname,
              timeout: 120_000,
              stdio: 'pipe',
            });
            execSync(`${PYTHON} -m src.exports.export_competitor_tracker`, {
              cwd: __dirname,
              timeout: 60_000,
              stdio: 'pipe',
            });
            sendJson(res, 200, { status: 'ok', duration: elapsed() });
          } catch (err: any) {
            sendJson(res, 500, { status: 'error', duration: elapsed(), message: formatError(err) });
          }
        });

        // POST /api/export/shapefile — generate shapefile ZIP via Python backend
        server.middlewares.use('/api/export/shapefile', (req, res, next) => {
          if (req.method !== 'POST') return next();

          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            const start = Date.now();
            const elapsed = () => `${((Date.now() - start) / 1000).toFixed(1)}s`;

            try {
              const { geography, regionIds } = JSON.parse(body || '{}');
              const geo = (geography || 'county').toLowerCase();
              if (!['msa', 'county', 'tract'].includes(geo)) {
                sendJson(res, 400, { status: 'error', message: `Invalid geography: ${geo}` });
                return;
              }

              const args = ['-m', 'src.cli.export_cli', '-g', geo, '-f', 'shapefile', '-y'];
              if (Array.isArray(regionIds) && regionIds.length > 0) {
                args.push('-r', regionIds.join(','));
              }

              execFileSync(PYTHON, args, { cwd: __dirname, timeout: 300_000, stdio: 'pipe' });

              const zipName = `rankings_${geo}_shapefile.zip`;
              const zipPath = path.join(__dirname, 'data/exports', zipName);

              if (fs.existsSync(zipPath)) {
                sendJson(res, 200, { status: 'ok', duration: elapsed(), file: `/data/exports/${zipName}` });
              } else {
                sendJson(res, 500, { status: 'error', duration: elapsed(), message: 'Shapefile ZIP not found after export' });
              }
            } catch (err: any) {
              sendJson(res, 500, { status: 'error', duration: elapsed(), message: formatError(err) });
            }
          });
        });

        // Serve static data exports (JSON, GeoJSON, CSV)
        server.middlewares.use('/data/exports', (req, res, next) => {
          const exportsRoot = path.join(__dirname, 'data/exports');
          const filePath = path.resolve(exportsRoot, (req.url || '').replace(/^\/+/, ''));
          if (!filePath.startsWith(exportsRoot + path.sep) && filePath !== exportsRoot) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const contentType =
              ext === '.csv'  ? 'text/csv; charset=utf-8' :
              ext === '.geojson' ? 'application/geo+json' :
              ext === '.zip' ? 'application/zip' :
              'application/json';
            res.setHeader('Content-Type', contentType);
            fs.createReadStream(filePath).pipe(res);
          } else {
            next();
          }
        });
      },
    },
  ],
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
    alias: {
      'vaul@1.1.2': 'vaul',
      'sonner@2.0.3': 'sonner',
      'recharts@2.15.2': 'recharts',
      'react-resizable-panels@2.1.7': 'react-resizable-panels',
      'react-hook-form@7.55.0': 'react-hook-form',
      'react-day-picker@8.10.1': 'react-day-picker',
      'next-themes@0.4.6': 'next-themes',
      'lucide-react@0.487.0': 'lucide-react',
      'input-otp@1.4.2': 'input-otp',
      'embla-carousel-react@8.6.0': 'embla-carousel-react',
      'cmdk@1.1.1': 'cmdk',
      'class-variance-authority@0.7.1': 'class-variance-authority',
      '@radix-ui/react-tooltip@1.1.8': '@radix-ui/react-tooltip',
      '@radix-ui/react-toggle@1.1.2': '@radix-ui/react-toggle',
      '@radix-ui/react-toggle-group@1.1.2': '@radix-ui/react-toggle-group',
      '@radix-ui/react-tabs@1.1.3': '@radix-ui/react-tabs',
      '@radix-ui/react-switch@1.1.3': '@radix-ui/react-switch',
      '@radix-ui/react-slot@1.1.2': '@radix-ui/react-slot',
      '@radix-ui/react-slider@1.2.3': '@radix-ui/react-slider',
      '@radix-ui/react-separator@1.1.2': '@radix-ui/react-separator',
      '@radix-ui/react-select@2.1.6': '@radix-ui/react-select',
      '@radix-ui/react-scroll-area@1.2.3': '@radix-ui/react-scroll-area',
      '@radix-ui/react-radio-group@1.2.3': '@radix-ui/react-radio-group',
      '@radix-ui/react-progress@1.1.2': '@radix-ui/react-progress',
      '@radix-ui/react-popover@1.1.6': '@radix-ui/react-popover',
      '@radix-ui/react-navigation-menu@1.2.5': '@radix-ui/react-navigation-menu',
      '@radix-ui/react-menubar@1.1.6': '@radix-ui/react-menubar',
      '@radix-ui/react-label@2.1.2': '@radix-ui/react-label',
      '@radix-ui/react-hover-card@1.1.6': '@radix-ui/react-hover-card',
      '@radix-ui/react-dropdown-menu@2.1.6': '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-dialog@1.1.6': '@radix-ui/react-dialog',
      '@radix-ui/react-context-menu@2.2.6': '@radix-ui/react-context-menu',
      '@radix-ui/react-collapsible@1.1.3': '@radix-ui/react-collapsible',
      '@radix-ui/react-checkbox@1.1.4': '@radix-ui/react-checkbox',
      '@radix-ui/react-avatar@1.1.3': '@radix-ui/react-avatar',
      '@radix-ui/react-aspect-ratio@1.1.2': '@radix-ui/react-aspect-ratio',
      '@radix-ui/react-alert-dialog@1.1.6': '@radix-ui/react-alert-dialog',
      '@radix-ui/react-accordion@1.2.3': '@radix-ui/react-accordion',
      '@': path.resolve(__dirname, './src/ui/src'),
    },
  },
  build: {
    target: 'esnext',
    outDir: 'build',
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      // Route substation + override API calls to FastAPI on port 8000.
      // Start FastAPI with: uvicorn src.api.main:app --reload --port 8000
      '/api/substations': 'http://localhost:8000',
      '/api/overrides':   'http://localhost:8000',
      '/api/health':      'http://localhost:8000',
    },
  },
});
