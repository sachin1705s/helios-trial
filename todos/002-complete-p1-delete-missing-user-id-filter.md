---
name: DELETE voice-clones and characters missing user_id ownership check (IDOR)
description: Both DELETE handlers filter only by id, not user_id — any authenticated user can delete any other user's resource
type: p1
status: pending
issue_id: "002"
tags: [security, code-review]
dependencies: [auth implementation]
---

## Problem Statement

Both DELETE endpoints filter only by the resource's primary key, not the calling user's ID:

```js
// DELETE /api/user/voice-clones/:id
await req.supabase.from('voice_clones').delete().eq('id', req.params.id);
// Missing: .eq('user_id', req.userId)

// DELETE /api/user/characters/:id
await req.supabase.from('characters').delete().eq('id', req.params.id);
// Missing: .eq('user_id', req.userId)
```

**Currently** the `requireAuth` stub returns 501 so these routes are inaccessible. **The moment auth ships**, any authenticated user can delete any other user's voice clone or character by guessing or enumerating UUIDs. The broken pattern is baked in and will be live automatically.

The POST (INSERT) correctly scopes to `req.userId`. The GET relies on RLS. Only DELETE is missing the filter.

## Findings

- `server/index.js` lines ~394–401 (`voice_clones` DELETE)
- `server/index.js` lines ~437–443 (`characters` DELETE)
- Classic IDOR (Insecure Direct Object Reference) pattern

## Proposed Solutions

### Option A: Add user_id filter (required)
```js
await req.supabase
  .from('voice_clones')
  .delete()
  .eq('id', req.params.id)
  .eq('user_id', req.userId);  // scope to owner
```
If the id doesn't belong to the user, Supabase deletes 0 rows and returns no error — return 404 in that case:
```js
const { error, count } = await req.supabase
  .from('voice_clones')
  .delete({ count: 'exact' })
  .eq('id', req.params.id)
  .eq('user_id', req.userId);
if (!error && count === 0) return res.status(404).json({ error: 'Not found.' });
```

### Option B: Rely on Supabase RLS policies
Add a RLS policy: `DELETE ON voice_clones WHERE user_id = auth.uid()`. This works if using Supabase Auth tokens, but `requireAuth` uses service role key — RLS is bypassed for service role. Not sufficient on its own.

## Recommended Action

Option A — add `.eq('user_id', req.userId)` to both DELETE handlers now, before auth is wired up.

## Acceptance Criteria

- [ ] `DELETE /api/user/voice-clones/:id` only deletes the row if `user_id` matches the authenticated user
- [ ] `DELETE /api/user/characters/:id` same
- [ ] Returns 404 (not 500) when id exists but belongs to a different user
