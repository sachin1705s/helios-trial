import { createClient } from '@supabase/supabase-js';

const supabaseUrl            = process.env.SUPABASE_URL            || '';
const supabaseAnonKey        = process.env.SUPABASE_ANON_KEY        || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Admin client — verifies JWTs server-side only, never exposed to clients
const supabaseAdmin = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

export const requireAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token.' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Auth not configured — missing Supabase env vars.' });
  }

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  // User-scoped client — Supabase RLS policies apply via the user JWT
  req.userId  = user.id;
  req.supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });

  return next();
};
