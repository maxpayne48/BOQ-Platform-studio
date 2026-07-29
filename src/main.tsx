import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ThemeProvider} from './ThemeContext.tsx';
import {TourProvider} from './tour/TourContext.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TourProvider>
        <App />
      </TourProvider>
    </ThemeProvider>
  </StrictMode>,
);
