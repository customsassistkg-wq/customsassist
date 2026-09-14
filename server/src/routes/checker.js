const path = require('node:path');
const express = require('express');
const router = express.Router();

router.get('/', (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  if (!req.user) return res.status(401).json({error: 'not authenticated', reason: req.authReason || null});
  if (!req.user.email_verified_at) return res.status(403).json({error: 'email_not_verified'});
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, '../../private/checker.js'), {cacheControl: false, lastModified: false}, err => {
    if (err) next(err);
  });
});

module.exports = router;
