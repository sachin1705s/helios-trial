import { Link } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { characters } from '../shared/characters';
import { AtriumNav, AtriumFooter } from './Layout';
import MusicToggle from './MusicToggle';
import '../shared/tokens.css';
import './Atrium.css';

const previewIds = ['bear', 'da-vinci', 'cleopatra', 'circus-lion'];
const featuredCharacters = previewIds
  .map((id) => characters.find((c) => c.id === id))
  .filter(Boolean) as typeof characters;

export default function AtriumLanding() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    // Best-effort autoplay — muted, looped, inline. No modal hijack.
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.play().catch(() => undefined);
  }, []);

  return (
    <div className="atrium">
      <AtriumNav />

      {/* HERO */}
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__copy">
          <span className="eyebrow">
            <span className="eyebrow__dot" /> Real-time interactive voice
          </span>
          <h1 id="hero-title">
            Worlds that <em>talk&nbsp;back.</em>
          </h1>
          <p className="lede">
            Speak to a character. Step into a scene. Watch the story bend
            around your voice, in real time, with no script, no scroll, and
            no autoplay feed in sight.
          </p>
          <div className="hero__ctas">
            <Link to="/characters" className="btn btn--primary">
              Try a character
              <span className="btn__arrow">→</span>
            </Link>
            <a href="#how" className="btn btn--ghost">
              See how it works
            </a>
          </div>
        </div>

        <div className="hero__viewfinder">
          <div className="viewfinder">
            <video
              ref={videoRef}
              src="/Starter-Demo.mp4"
              autoPlay
              muted
              loop
              playsInline
              poster="/images/forest-canopy.jpg"
            />
            <div className="viewfinder__chrome">
              <span className="viewfinder__rec" /> LIVE
            </div>
            <div className="viewfinder__caption">
              Steve the Bear, responding to a question
            </div>
          </div>
          <div className="viewfinder__shadow" aria-hidden />
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="how" aria-labelledby="how-title">
        <header>
          <span className="eyebrow eyebrow--center">In thirty seconds</span>
          <h2 id="how-title">
            Three steps. <em>That's the whole thing.</em>
          </h2>
        </header>
        <ol className="how__steps">
          <li>
            <span className="step__num">01</span>
            <h3>Choose who you'd like to meet.</h3>
            <p>
              A wise bear. A Renaissance inventor. A pharaoh. Each character
              has their own voice, world, and way of seeing things.
            </p>
          </li>
          <li>
            <span className="step__num">02</span>
            <h3>Speak in your own voice.</h3>
            <p>
              Press once and talk. No keyboard, no commands. The character is
              listening, and they remember what you said two minutes ago.
            </p>
          </li>
          <li>
            <span className="step__num">03</span>
            <h3>The world responds.</h3>
            <p>
              Not a stock reply. The scene shifts, the character moves, and
              the story bends around the conversation you're actually having.
            </p>
          </li>
        </ol>
      </section>

      {/* CHARACTER PREVIEW */}
      <section className="preview" aria-labelledby="preview-title">
        <header>
          <span className="eyebrow">The cast</span>
          <h2 id="preview-title">
            A cast of characters. <em>One conversation each.</em>
          </h2>
          <p className="lede lede--center">
            From a wise bear to the last pharaoh of Egypt. Pick the
            voice you want to spend time with.
          </p>
        </header>
        <div className="preview__grid">
          {featuredCharacters.map((c) => (
            <Link key={c.id} to={`/character/${c.id}`} className="preview__card">
              <div className="preview__photo">
                <img src={c.image} alt={c.title} loading="lazy" />
              </div>
              <div className="preview__meta">
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </div>
              <span className="preview__cta">Talk to {c.title} →</span>
            </Link>
          ))}
        </div>
        <div className="preview__more">
          <Link to="/characters" className="btn btn--ghost btn--lg">
            Meet the full cast →
          </Link>
        </div>
      </section>

      <AtriumFooter />
      <MusicToggle />
    </div>
  );
}
