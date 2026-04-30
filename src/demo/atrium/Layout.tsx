import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';

export function AtriumNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav className={`nav${scrolled ? ' nav--scrolled' : ''}`} aria-label="Primary">
      <Link to="/" className="nav__brand">
        Interact Studio
      </Link>
      <div className="nav__actions">
        <Link to="/about-us" className="btn btn--ghost btn--sm">
          About
        </Link>
        <Link to="/characters" className="btn btn--primary btn--sm">
          Try a character
        </Link>
      </div>
    </nav>
  );
}

export function AtriumFooter() {
  return (
    <footer className="foot">
      <div className="foot__top">
        <div className="foot__brand">
          <img src="/favicon.jpeg" alt="" className="nav__mark" aria-hidden="true" />
          <span>Interact Studio</span>
        </div>
        <div className="foot__cols">
          <div>
            <h4>Product</h4>
            <Link to="/characters">Characters</Link>
            <a href="/#how">How it works</a>
          </div>
          <div>
            <h4>Company</h4>
            <Link to="/about-us">About</Link>
            <a href="mailto:hello.interactstudio@gmail.com">Contact</a>
          </div>
          <div>
            <h4>Community</h4>
            <a href="https://discord.gg/S4b2sJrsuS" target="_blank" rel="noreferrer">Discord</a>
            <a href="https://x.com/interact_studio" target="_blank" rel="noreferrer">X / Twitter</a>
            <a href="https://www.instagram.com/iinteractstudio/" target="_blank" rel="noreferrer">Instagram</a>
          </div>
        </div>
      </div>
      <div className="foot__bottom">
        <span>© Interact Studio 2026</span>
        <span>Made for curious minds, anywhere.</span>
      </div>
    </footer>
  );
}
