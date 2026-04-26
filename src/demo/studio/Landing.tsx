import { Link } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { characters } from '../shared/characters';
import '../shared/tokens.css';
import './Studio.css';

const previewIds = ['bear', 'da-vinci', 'cleopatra', 'einstein'];
const featured = previewIds
  .map((id) => characters.find((c) => c.id === id))
  .filter(Boolean) as typeof characters;

export default function StudioLanding() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.play().catch(() => undefined);
  }, []);

  return (
    <div className="studio">
      <nav className="sb-nav">
        <Link to="/demo/landing-studio" className="sb-brand">
          <span className="sb-mark">⌬</span>
          INTERACT STUDIO
        </Link>
        <div className="sb-nav__links">
          <a href="#how" onClick={(e) => e.preventDefault()}>Concept</a>
          <Link to="/demo/home">Cast</Link>
          <a href="#" onClick={(e) => e.preventDefault()}>Press</a>
        </div>
        <Link to="/demo/home" className="sb-btn">
          Begin →
        </Link>
      </nav>

      <section className="sb-hero">
        <video
          ref={videoRef}
          src="/Starter-Demo.mp4"
          autoPlay
          muted
          loop
          playsInline
          poster="/images/forest-canopy.jpg"
          className="sb-hero__video"
        />
        <div className="sb-hero__veil" />

        <div className="sb-hero__copy">
          <span className="sb-eyebrow">A new medium · Real-time interactive voice</span>
          <h1>
            Worlds.<br />
            <em>That&nbsp;talk&nbsp;back.</em>
          </h1>
          <p>
            Step into a scene. Speak in your own voice. Watch the story
            answer in real time — no script, no playback, no feed.
          </p>
          <div className="sb-cta-row">
            <Link to="/demo/home" className="sb-btn sb-btn--ember">
              Begin a conversation
              <span className="sb-arrow">→</span>
            </Link>
            <a href="#" onClick={(e) => e.preventDefault()} className="sb-link">
              Watch the reel
            </a>
          </div>
        </div>

        <div className="sb-hero__meta">
          <span>S01 · E01</span>
          <span>The opening conversation</span>
          <span>00:32</span>
        </div>
      </section>

      <section className="sb-credo">
        <div className="sb-credo__grid">
          <span className="sb-num">01</span>
          <h2>
            Not a feed. <em>A scene.</em>
          </h2>
          <p>
            Every other screen on your phone is trying to keep you scrolling.
            We are trying to keep you in <em>one</em> conversation.
          </p>
        </div>
        <div className="sb-credo__grid sb-credo__grid--alt">
          <span className="sb-num">02</span>
          <h2>
            Not a script. <em>A response.</em>
          </h2>
          <p>
            The character is generated in real time, listening to the words
            you actually said — not playing back a recording you've already
            heard.
          </p>
        </div>
        <div className="sb-credo__grid">
          <span className="sb-num">03</span>
          <h2>
            Not a chatbot. <em>A face.</em>
          </h2>
          <p>
            Eyes that meet yours. A scene that shifts. A voice with weather
            in it. The kind of thing you remember the next morning.
          </p>
        </div>
      </section>

      <section className="sb-cast">
        <header>
          <span className="sb-eyebrow sb-eyebrow--center">The cast — eight</span>
          <h2>
            Choose <em>your</em> conversation.
          </h2>
        </header>
        <div className="sb-cast__row">
          {featured.map((c) => (
            <Link key={c.id} to={`/demo/character/${c.id}`} className="sb-card">
              <div className="sb-card__photo">
                <img src={c.image} alt={c.title} />
              </div>
              <div className="sb-card__meta">
                <span className="sb-card__sub">{c.subtitle}</span>
                <h3>{c.title}</h3>
                <span className="sb-card__cta">Talk to {c.title.split(' ')[0]} →</span>
              </div>
            </Link>
          ))}
        </div>
        <div className="sb-cta-center">
          <Link to="/demo/home" className="sb-btn sb-btn--ghost sb-btn--big">
            See all eight →
          </Link>
        </div>
      </section>

      <footer className="sb-foot">
        <div>
          <span className="sb-mark">⌬</span>
          <strong>INTERACT STUDIO</strong>
        </div>
        <p>For the curious. Wherever you are.</p>
        <div className="sb-foot__links">
          <a href="#" onClick={(e) => e.preventDefault()}>Discord</a>
          <a href="#" onClick={(e) => e.preventDefault()}>Instagram</a>
          <a href="#" onClick={(e) => e.preventDefault()}>X</a>
        </div>
      </footer>
    </div>
  );
}
