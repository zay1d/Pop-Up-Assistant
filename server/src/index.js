import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { workspace } from './routes/workspace.js';
import { documents } from './routes/documents.js';

const app = express();
// The workspace dump carries no blobs (those go to R2), but with many
// placements/activities the JSON can still be a few MB — allow headroom.
app.use(express.json({ limit: '32mb' }));

const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// NOTE: no authentication. Reads AND writes are open to anyone who can reach
// the API — this is an explicit product decision (shared, fully editable
// dataset). Access control relies on keeping the API URL private + CORS.
app.use('/api', workspace);
app.use('/api', documents);

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const port = process.env.PORT || 8090;
// Bind to loopback only — the API is never exposed publicly; a reverse proxy
// or Tailscale Funnel fronts it with TLS. Override with HOST=0.0.0.0 if needed.
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Pop-Up API listening on ${host}:${port}`));
