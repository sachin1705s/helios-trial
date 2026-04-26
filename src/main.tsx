import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import App from './App.tsx';
import DemoIndex from './demo/Index';
import AtriumLanding from './demo/atrium/Landing';
import AtriumHome from './demo/atrium/Home';
import AtriumCharacter from './demo/atrium/Character';
import StorylineLanding from './demo/storyline/Landing';
import StudioLanding from './demo/studio/Landing';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/demo" element={<DemoIndex />} />
        <Route path="/demo/landing" element={<AtriumLanding />} />
        <Route path="/demo/home" element={<AtriumHome />} />
        <Route path="/demo/character/:id" element={<AtriumCharacter />} />
        <Route path="/demo/landing-storyline" element={<StorylineLanding />} />
        <Route path="/demo/landing-studio" element={<StudioLanding />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
