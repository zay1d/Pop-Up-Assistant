import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { presignUpload, downloadUrl, deleteObject } from '../r2.js';

export const documents = Router();

// All endpoints are open (no auth) — see the note in index.js.

// Step 1: register a document and get a presigned URL to upload straight to R2.
documents.post('/documents/presign', async (req, res) => {
  const { filename, contentType = 'application/octet-stream', size = null } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'Не указано имя файла' });

  // Keep the key readable but safe; the UUID guarantees uniqueness.
  const safe = String(filename).replace(/[^\w.\-]+/g, '_').slice(-120);
  const storageKey = `docs/${randomUUID()}-${safe}`;
  const { rows } = await query(
    `INSERT INTO documents (filename, content_type, size, storage_key, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
    [filename, contentType, size, storageKey]
  );
  const uploadUrl = await presignUpload(storageKey, contentType);
  res.status(201).json({ documentId: rows[0].id, uploadUrl, storageKey });
});

// Step 2: after the browser finishes the PUT to R2, mark the document ready.
documents.post('/documents/:id/confirm', async (req, res) => {
  const { rows } = await query(
    `UPDATE documents SET status = 'ready' WHERE id = $1
       RETURNING id, filename, size, status`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Документ не найден' });
  res.json(rows[0]);
});

// Issue a short-lived download URL (redirect) for a ready document.
documents.get('/documents/:id/download', async (req, res) => {
  const { rows } = await query(
    `SELECT storage_key, status FROM documents WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length || rows[0].status !== 'ready') {
    return res.status(404).json({ error: 'Документ не найден' });
  }
  const url = await downloadUrl(rows[0].storage_key);
  res.redirect(url);
});

documents.delete('/documents/:id', async (req, res) => {
  const { rows } = await query(
    `DELETE FROM documents WHERE id = $1 RETURNING storage_key`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Документ не найден' });
  try {
    await deleteObject(rows[0].storage_key);
  } catch (err) {
    console.error('R2 delete failed (metadata already removed):', err.message);
  }
  res.status(204).end();
});
