import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useParams, useLocation } from 'react-router-dom';
import './index.css';
import App from './App.tsx';
import AtriumLanding from './demo/atrium/Landing';
import AtriumHome from './demo/atrium/Home';
import AtriumAbout from './demo/atrium/About';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

function CharacterRoute() {
  const { id } = useParams<{ id: string }>();
  return <App initialCharacterId={id} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<AtriumLanding />} />
        <Route path="/home" element={<AtriumHome />} />
        <Route path="/about-us" element={<AtriumAbout />} />
        <Route path="/character/:id" element={<CharacterRoute />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
