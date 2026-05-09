import { Link } from 'react-router-dom';
import { AtriumNav, AtriumFooter } from './Layout';
import MusicToggle from './MusicToggle';
import { EXPERIMENTS, endOfDay, getStatus, formatOpenDate, formatDateRange, minutesUntilLive } from './experiments';
import '../shared/tokens.css';
import './Atrium.css';
import './Labs.css';

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
          Most AI makes you more efficient. These are built to make you feel something.
          {allDone && ' All experiments are now open.'}
        </p>
      </section>

      <section className="labs-experiments" aria-label="Experiments">
        {EXPERIMENTS.map((exp, i) => {
          const nextStart = EXPERIMENTS[i + 1]?.start;
          const status = getStatus(exp.start, exp.end, allDone, nextStart);
          const isClickable = status === 'live' || status === 'archive';

          // Countdown for upcoming experiments
          const mins = status === 'upcoming' ? minutesUntilLive(exp.start) : 0;
          const upcomingLabel = mins < 24 * 60 && mins > 0
            ? `Opens in ${Math.floor(mins / 60)}h ${mins % 60}m`
            : `Opens ${formatOpenDate(exp.start)}`;

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
                    {status === 'ended' && '🔒 Locked'}
                    {status === 'upcoming' && upcomingLabel}
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
