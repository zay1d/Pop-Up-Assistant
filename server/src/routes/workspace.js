import { Router } from 'express';
import { query } from '../db.js';

export const workspace = Router();

// ── Read the shared dataset (public) ───────────────────────────────
// Returns the full Pop-Up dump (zones, placements, history, labels,
// activities, files — metadata only) plus when it was last saved.
workspace.get('/workspace', async (_req, res) => {
  const { rows } = await query('SELECT state, updated_at FROM workspace WHERE id = 1');
  if (!rows.length) return res.json({ state: {}, updated_at: null });
  res.json(rows[0]);
});

// ── Save the shared dataset (open — no auth) ───────────────────────
// Replaces the entire dataset. Safe under the single-editor model.
workspace.put('/workspace', async (req, res) => {
  const state = req.body?.state;
  if (state == null || typeof state !== 'object' || Array.isArray(state)) {
    return res.status(400).json({ error: 'Ожидается объект state' });
  }
  const { rows } = await query(
    `INSERT INTO workspace (id, state, updated_at)
          VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
       RETURNING updated_at`,
    [state]
  );
  res.json({ ok: true, updated_at: rows[0].updated_at });
});
