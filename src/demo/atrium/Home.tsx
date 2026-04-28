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
  all: 'All',
  storytellers: 'Storytellers',
  historical: 'Historical',
  visionaries: 'Visionaries',
};

export default function AtriumHome() {
  const [filter, setFilter] = useState<Filter>('all');

  const castCharacters = useMemo(
    () => characters.filter((c) => (tags[c.id] ?? ['all']).includes(filter)),
    [filter],
  );

  return (
    <div className="atrium atrium-home">
      <AtriumNav />

      <section className="home-hero" aria-labelledby="cast-title">
        <div className="home-hero__copy">
          <span className="eyebrow">
            <span className="eyebrow__dot" /> Choose who you'd like to meet
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
            return (
              <button
                key={f}
                role="tab"
                aria-selected={active}
                className={`pill ${active ? 'pill--on' : ''}`}
                onClick={() => setFilter(f)}
              >
                {filterLabel[f]}
              </button>
            );
          })}
        </div>
      </section>

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
              <span className="cast__cta">Talk to {c.title} →</span>
            </Link>
          ))}
        </div>
        {castCharacters.length === 0 && (
          <p className="cast__empty">
            No one in this group right now. <button onClick={() => setFilter('all')}>See everyone →</button>
          </p>
        )}
      </section>

      <AtriumFooter />
      <MusicToggle />
    </div>
  );
}
