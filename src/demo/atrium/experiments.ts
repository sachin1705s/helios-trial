export const EXPERIMENTS = [
  {
    id: 'drawing',
    label: 'Drawn to Life',
    route: '/lab/drawing',
    desc: 'A face, a beach, a sunset — any drawing or photo becomes a living world you can step into and talk to.',
    start: '2026-05-05',
    end: '2026-05-08',
    gradient: 'linear-gradient(135deg, #F0B546 0%, #E87030 100%)',
  },
  {
    id: 'gesture',
    label: 'Body Language',
    route: '/lab/gesture',
    desc: 'Words are only half the story. Move your hands, lean in, point — the character reads your body and responds.',
    start: '2026-05-09',
    end: '2026-05-11',
    gradient: 'linear-gradient(135deg, #7B5EA7 0%, #4A3580 100%)',
  },
  {
    id: 'objects',
    label: 'Show & Tell',
    route: '/lab/objects',
    desc: 'Hold something up. The character doesn\'t just see it — it reacts, has a take, and wants to talk about it.',
    start: '2026-05-12',
    end: '2026-05-14',
    gradient: 'linear-gradient(135deg, #2F8F6A 0%, #1B5A45 100%)',
  },
  {
    id: 'custom',
    label: 'Wear the Character',
    route: '/lab/custom',
    desc: 'One photo. One voice clip. Your look and sound — wired to a digital brain that speaks as you.',
    start: '2026-05-15',
    end: '2026-05-17',
    gradient: 'linear-gradient(135deg, #D9492B 0%, #9E2D10 100%)',
  },
  {
    id: 'broadcast',
    label: 'Open the Room',
    route: '/lab/broadcast',
    desc: 'AI stops being a private assistant. Open a room, share the link — anyone can walk in and talk to it, live.',
    start: '2026-05-18',
    end: '2026-05-20',
    gradient: 'linear-gradient(135deg, #3A6FD8 0%, #1A4AA0 100%)',
  },
] as const;

export type Experiment = (typeof EXPERIMENTS)[number];

export type Status = 'live' | 'ended' | 'upcoming' | 'archive';

export function parseLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function endOfDay(dateStr: string): Date {
  const d = parseLocal(dateStr);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function getStatus(start: string, end: string, allDone: boolean): Status {
  if (allDone) return 'archive';
  const now = new Date();
  if (now < parseLocal(start)) return 'upcoming';
  if (now > endOfDay(end)) return 'ended';
  return 'live';
}

export function formatOpenDate(dateStr: string): string {
  const d = parseLocal(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatDateRange(start: string, end: string): string {
  const s = parseLocal(start);
  const e = parseLocal(end);
  const month = s.toLocaleDateString('en-US', { month: 'short' });
  return `${month} ${s.getDate()}–${e.getDate()}`;
}
