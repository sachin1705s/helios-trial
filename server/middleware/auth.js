// Stub auth middleware — auth is not implemented on this branch.
// requireAuth returns 501 so protected routes fail gracefully instead of crashing the server.
export const requireAuth = (_req, res) => {
  res.status(501).json({ error: 'Auth not implemented on this branch.' });
};
