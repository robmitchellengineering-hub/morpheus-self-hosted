import { Router } from 'express';
import { requireAuth, blockWidget } from '../auth.js';
import {
  isKnownEntity, listEntities, filterEntities, getEntity,
  createEntity, updateEntity, deleteEntity, deleteManyByQuery, bulkCreateEntities,
} from '../entities.js';

const router = Router();
router.use(requireAuth, blockWidget);

router.use('/:name', (req, res, next) => {
  if (!isKnownEntity(req.params.name)) return res.status(404).json({ error: `Unknown entity: ${req.params.name}` });
  next();
});

router.get('/:name', async (req, res) => {
  try {
    res.json(await listEntities(req.params.name, req.user, { sort: req.query.sort, limit: req.query.limit }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:name/filter', async (req, res) => {
  try {
    const { query, sort, limit } = req.body || {};
    res.json(await filterEntities(req.params.name, req.user, { query, sort, limit }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/:name/:id', async (req, res) => {
  try {
    res.json(await getEntity(req.params.name, req.user, req.params.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:name', async (req, res) => {
  try {
    res.status(201).json(await createEntity(req.params.name, req.user, req.body));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:name/bulk-create', async (req, res) => {
  try {
    res.status(201).json(await bulkCreateEntities(req.params.name, req.user, req.body?.items || []));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:name/bulk-delete', async (req, res) => {
  try {
    const count = await deleteManyByQuery(req.params.name, req.user, req.body?.query || {});
    res.json({ ok: true, count });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/:name/:id', async (req, res) => {
  try {
    res.json(await updateEntity(req.params.name, req.user, req.params.id, req.body));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/:name/:id', async (req, res) => {
  try {
    await deleteEntity(req.params.name, req.user, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
