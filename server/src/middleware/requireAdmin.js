// Re-checks role/active from req.user (populated fresh from the DB by
// middleware/auth.js on this same request) rather than trusting anything
// the client sent.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin' || !req.user.active) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

module.exports = requireAdmin;
