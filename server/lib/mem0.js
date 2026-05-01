import { MemoryClient } from 'mem0ai';

const client = process.env.MEM0_API_KEY
  ? new MemoryClient({ apiKey: process.env.MEM0_API_KEY })
  : null;

const FETCH_TIMEOUT_MS = 4000;
const MAX_MEMORY_CHARS = 500;
const MAX_MEMORY_ITEMS = 10;

/**
 * Fetch relevant memories for a (user, character) pair.
 * Returns [] on any failure — never throws.
 */
export async function fetchMemories(userId, agentId, query) {
  if (!client || !userId) return [];
  try {
    const results = await Promise.race([
      client.search(query, { user_id: userId, agent_id: agentId }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('mem0 timeout')), FETCH_TIMEOUT_MS)
      ),
    ]);
    return Array.isArray(results) ? results : [];
  } catch (err) {
    console.warn('[mem0] fetch failed:', err?.message);
    return [];
  }
}

/**
 * Format memories for system prompt injection.
 * Returns empty string if no memories.
 */
export function formatMemoriesForPrompt(memories) {
  if (!memories.length) return '';
  const text = memories
    .slice(0, MAX_MEMORY_ITEMS)
    .map((m) => m.memory ?? m.text ?? '')
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_MEMORY_CHARS);
  return text ? `What you remember about this user:\n${text}` : '';
}

/**
 * Save an exchange to Mem0. Fire-and-forget — errors are logged, never thrown.
 */
export function saveMemory(userId, agentId, userText, assistantText) {
  if (!client || !userId) return;
  client
    .add(
      [
        { role: 'user', content: userText },
        { role: 'assistant', content: assistantText },
      ],
      { user_id: userId, agent_id: agentId }
    )
    .catch((err) => console.error('[mem0] save failed:', err?.message));
}
