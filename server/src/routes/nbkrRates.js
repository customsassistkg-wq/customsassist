const express = require('express');
const { getRates } = require('../services/nbkrRates');

const router = express.Router();

router.get('/', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authenticated', reason: req.authReason || null });
  const rates = await getRates();
  if (!rates) return res.status(503).json({ error: 'rates unavailable' });
  res.json(rates);
});

module.exports = router;
