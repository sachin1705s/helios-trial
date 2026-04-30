import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useParams, useLocation, Navigate } from 'react-router-dom';
import './index.css';
import App from './App.tsx';
import AtriumLanding from './demo/atrium/Landing';
import AtriumHome from './demo/atrium/Home';
import AtriumAbout from './demo/atrium/About';
import DrawingExperiment from './components/experiments/DrawingExperiment';
import GestureExperiment from './components/experiments/GestureExperiment';
import ObjectDetectionExperiment from './components/experiments/ObjectDetectionExperiment';
import CustomCharacterExperiment from './components/experiments/CustomCharacterExperiment';
import BroadcastExperiment from './components/experiments/BroadcastExperiment';

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
        <Route path="/characters" element={<AtriumHome />} />
        {/* Legacy: the cast page used to live at /home — keep the URL working. */}
        <Route path="/home" element={<Navigate to="/characters" replace />} />
        <Route path="/about-us" element={<AtriumAbout />} />
        <Route path="/character/:id" element={<CharacterRoute />} />
        <Route path="/lab/drawing"   element={<DrawingExperiment />} />
        <Route path="/lab/gesture"   element={<GestureExperiment />} />
        <Route path="/lab/objects"   element={<ObjectDetectionExperiment />} />
        <Route path="/lab/custom"    element={<CustomCharacterExperiment />} />
        <Route path="/lab/broadcast" element={<BroadcastExperiment />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
