import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useParams } from 'react-router-dom';
import './index.css';
import App from './App.tsx';
import AtriumLanding from './demo/atrium/Landing';
import AtriumHome from './demo/atrium/Home';

function CharacterRoute() {
  const { id } = useParams<{ id: string }>();
  return <App initialCharacterId={id} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AtriumLanding />} />
        <Route path="/home" element={<AtriumHome />} />
        <Route path="/character/:id" element={<CharacterRoute />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
