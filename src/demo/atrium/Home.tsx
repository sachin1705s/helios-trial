import { Link } from 'react-router-dom';
import { useState, useMemo } from 'react';
import { characters } from '../shared/characters';
import { AtriumNav, AtriumFooter } from './Landing';
import MusicToggle from './MusicToggle';
import '../shared/tokens.css';
import './Atrium.css';
import './Home.css';

type Filter = 'all' | 'storytellers' | 'historical' | 'visionaries';

const tags: Record<string, Filter[]> = {
  bear: ['all', 'storytellers'],
  'circus-lion': ['all', 'storytellers'],
  'grandpa-turtle': ['all', 'storytellers'],
  alexander: ['all', 'historical'],
  cleopatra: ['all', 'historical'],
  'da-vinci': ['all', 'historical'],
  einstein: ['all', 'historical', 'visionaries'],
  'steve-jobs': ['all', 'visionaries'],
};

const filterLabel: Record<Filter, string> = {
  all: 'All eight',
  storytellers: 'Storytellers',
  historical: 'Historical',
  visionaries: 'Visionaries',
};

const FEATURED_IDS = ['bear', 'da-vinci'];

export default function AtriumHome() {
  const [filter, setFilter] = useState<Filter>('all');

  const featured = FEATURED_IDS.map((id) => characters.find((c) => c.id === id)!);

  // On "all": featured row gets the two hero cards, cast grid gets the rest.
  // On any filter: skip the featured row entirely — show all matches uniformly.
  const castCharacters = useMemo(
    () =>
      filter === 'all'
        ? characters.filter((c) => !FEATURED_IDS.includes(c.id))
        : characters.filter((c) => (tags[c.id] ?? ['all']).includes(filter)),
    [filter],
  );

  return (
    <div className="atrium atrium-home">
      <AtriumNav />

      <section className="home-hero" aria-labelledby="cast-title">
        <div className="home-hero__copy">
          <span className="eyebrow">
            <span className="eyebrow__dot" /> Eight conversations available
          </span>
          <h1 id="cast-title">
            Choose your <em>conversation.</em>
          </h1>
          <p className="lede">
            Each character has their own voice, world, and way of seeing
            things. Pick one — you can always change your mind.
          </p>
        </div>
        <div className="home-hero__filters" role="tablist" aria-label="Filter the cast">
          {(Object.keys(filterLabel) as Filter[]).map((f) => {
            const active = filter === f;
            const count =
              f === 'all'
                ? characters.length
                : characters.filter((c) => (tags[c.id] ?? ['all']).includes(f)).length;
            return (
              <button
                key={f}
                role="tab"
                aria-selected={active}
                className={`pill ${active ? 'pill--on' : ''}`}
                onClick={() => setFilter(f)}
              >
                {filterLabel[f]}
                <span className="pill__count">{count}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Featured row — only shown on "All eight" */}
      {filter === 'all' && (
        <section className="featured" aria-label="Featured characters">
          {featured.map((c, i) => (
            <Link key={c.id} to={`/character/${c.id}`} className={`featured__card featured__card--${i}`}>
              <div className="featured__photo">
                <img src={c.image} alt={c.title} />
                <div className="featured__overlay" />
              </div>
              <div className="featured__meta">
                <h2>{c.title}</h2>
                <p className="featured__greeting">"{c.greeting}"</p>
                <span className="featured__cta">
                  Talk to {c.title.split(' ')[0]}
                  <span className="btn__arrow">→</span>
                </span>
              </div>
            </Link>
          ))}
        </section>
      )}

      {/* Cast grid — uniform design, all matching characters */}
      <section className="cast" aria-label="Full cast">
        <div className="cast__grid">
          {castCharacters.map((c) => (
            <Link key={c.id} to={`/character/${c.id}`} className="cast__card">
              <div className="cast__photo">
                <img src={c.image} alt={c.title} loading="lazy" />
              </div>
              <div className="cast__meta">
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </div>
              <span className="cast__cta">Talk to {c.title.split(' ')[0]} →</span>
            </Link>
          ))}
        </div>
        {castCharacters.length === 0 && (
          <p className="cast__empty">
            No one in this group right now. <button onClick={() => setFilter('all')}>See all eight →</button>
          </p>
        )}
      </section>

      <AtriumFooter />
      <MusicToggle />
    </div>
  );
}
