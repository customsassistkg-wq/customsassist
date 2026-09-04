const express = require('express');
const { search } = require('../services/classDecisions');

const router = express.Router();

router.get('/', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authenticated', reason: req.authReason || null });
  const code = (req.query.code || '').toString();
  res.json(search(code));
});

module.exports = router;
