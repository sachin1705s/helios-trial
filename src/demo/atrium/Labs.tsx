import { Link } from 'react-router-dom';
import { AtriumNav, AtriumFooter } from './Layout';
import MusicToggle from './MusicToggle';
import '../shared/tokens.css';
import './Atrium.css';
import './Labs.css';

const EXPERIMENTS = [
  {
    id: 'drawing',
    label: 'Drawn to Life',
    route: '/lab/drawing',
    desc: 'A photo goes in. The character sees it, thinks about it, and has things to say.',
    start: '2026-05-04',
    end: '2026-05-06',
    gradient: 'linear-gradient(135deg, #F0B546 0%, #E87030 100%)',
  },
  {
    id: 'gesture',
    label: 'Body Language',
    route: '/lab/gesture',
    desc: 'No buttons. Just your hands — and a character that watches your every move.',
    start: '2026-05-07',
    end: '2026-05-09',
    gradient: 'linear-gradient(135deg, #7B5EA7 0%, #4A3580 100%)',
  },
  {
    id: 'objects',
    label: 'Show & Tell',
    route: '/lab/objects',
    desc: 'Hold something up to the camera. The character sees it. Then it has opinions.',
    start: '2026-05-10',
    end: '2026-05-12',
    gradient: 'linear-gradient(135deg, #2F8F6A 0%, #1B5A45 100%)',
  },
  {
    id: 'custom',
    label: 'Wear the Character',
    route: '/lab/custom',
    desc: 'Your face. Your voice. Built into a character that moves and speaks like you.',
    start: '2026-05-13',
    end: '2026-05-15',
    gradient: 'linear-gradient(135deg, #D9492B 0%, #9E2D10 100%)',
  },
  {
    id: 'broadcast',
    label: 'Open the Room',
    route: '/lab/broadcast',
    desc: 'Start a room. Share the link. Let anyone talk to the same character at once.',
    start: '2026-05-16',
    end: '2026-05-18',
    gradient: 'linear-gradient(135deg, #3A6FD8 0%, #1A4AA0 100%)',
  },
] as const;

type Status = 'live' | 'ended' | 'upcoming' | 'archive';

// Parse YYYY-MM-DD as local midnight to avoid UTC-offset date shifts
function parseLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function endOfDay(dateStr: string): Date {
  const d = parseLocal(dateStr);
  d.setHours(23, 59, 59, 999);
  return d;
}

function getStatus(start: string, end: string, allDone: boolean): Status {
  if (allDone) return 'archive';
  const now = new Date();
  if (now < parseLocal(start)) return 'upcoming';
  if (now > endOfDay(end)) return 'ended';
  return 'live';
}

function formatOpenDate(dateStr: string): string {
  const d = parseLocal(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateRange(start: string, end: string): string {
  const s = parseLocal(start);
  const e = parseLocal(end);
  const month = s.toLocaleDateString('en-US', { month: 'short' });
  return `${month} ${s.getDate()}–${e.getDate()}`;
}

export default function AtriumLabs() {
  const now = new Date();
  const allDone = EXPERIMENTS.every((e) => now > endOfDay(e.end));

  return (
    <div className="atrium atrium-labs">
      <AtriumNav />

      <section className="labs-hero">
        <span className="eyebrow eyebrow--center">
          <span className="eyebrow__dot" /> The Lab
        </span>
        <h1>
          Five experiments. <em>One at a time.</em>
        </h1>
        <p className="lede lede--center">
          Each one live for three days — one new experience every few days.
          {allDone && ' All experiments are now open.'}
        </p>
      </section>

      <section className="labs-experiments" aria-label="Experiments">
        {EXPERIMENTS.map((exp) => {
          const status = getStatus(exp.start, exp.end, allDone);
          const isClickable = status === 'live' || status === 'ended' || status === 'archive';

          const card = (
            <article
              key={exp.id}
              className={`lab-card lab-card--${status}`}
            >
              <div className="lab-card__body">
                <div className="lab-card__top">
                  <p className="lab-card__dates">{formatDateRange(exp.start, exp.end)}</p>
                  <span className={`lab-card__badge lab-badge--${status}`}>
                    {status === 'live' && (
                      <><span className="lab-badge__dot" />Live now</>
                    )}
                    {status === 'ended' && 'Ended'}
                    {status === 'upcoming' && `Opens ${formatOpenDate(exp.start)}`}
                    {status === 'archive' && 'Available'}
                  </span>
                </div>
                <h3>{exp.label}</h3>
                <p>{exp.desc}</p>
              </div>
            </article>
          );

          return isClickable ? (
            <Link key={exp.id} to={exp.route} className="lab-card-link">
              {card}
            </Link>
          ) : (
            <div key={exp.id} className="lab-card-link lab-card-link--inert">
              {card}
            </div>
          );
        })}
      </section>

      <AtriumFooter />
      <MusicToggle />
    </div>
  );
}
