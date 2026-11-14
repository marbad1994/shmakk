import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useApp } from '@/store/app';
import { App } from './App';
import './index.css';


void useApp.getState().init().catch((e) => {
  document.getElementById('root')!.textContent = `shmakk could not start: ${e?.message || e}`;
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={350} skipDelayDuration={200}>
        <App />
        <Toaster
          position="bottom-right"
          offset={{ bottom: 40, right: 16 }}
          mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 56px)' }}
          toastOptions={{
            style: { background: 'var(--raised)', color: 'var(--fg)', border: '1px solid var(--line-strong)', fontFamily: 'var(--font-sans)', fontSize: '13px' },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
