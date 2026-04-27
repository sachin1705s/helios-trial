import { useEffect, useRef, useState } from 'react';

export default function MusicToggle() {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handleToggle = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      return;
    }

    setIsPlaying(true);
    void audio.play().catch(() => setIsPlaying(false));
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.loop = true;
    audio.volume = 0.35;
  }, []);

  return (
    <>
      <audio ref={audioRef} src="/background-music.mpeg" preload="none" aria-hidden="true" />
      <button
        type="button"
        className={`atrium-music-toggle ${isPlaying ? 'is-playing' : 'is-paused'}`}
        onClick={handleToggle}
        aria-label={isPlaying ? 'Pause background music' : 'Play background music'}
        aria-pressed={isPlaying}
      >
        <span className="atrium-music-bars" aria-hidden="true">
          <span className="atrium-music-bar" />
          <span className="atrium-music-bar" />
          <span className="atrium-music-bar" />
          <span className="atrium-music-bar" />
          <span className="atrium-music-bar" />
        </span>
      </button>
    </>
  );
}
