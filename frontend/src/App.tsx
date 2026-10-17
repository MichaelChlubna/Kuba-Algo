import { useEffect, useRef, useState } from 'react';
import { api } from './api/client';
import { ChartEngine } from './chart/engine';
import { ChartView } from './components/ChartView';
import { SidePanel } from './components/SidePanel';
import { Toolbar } from './components/Toolbar';
import { useMedia, useT } from './hooks';
import { useSettings } from './store/settings';
import { useUi } from './store/ui';

export default function App() {
  const t = useT();
  const theme = useSettings((s) => s.theme);
  const lang = useSettings((s) => s.lang);
  const side = useSettings((s) => s.layout.side);
  const wide = useMedia('(min-width: 1024px)');
  const selected = useUi((s) => s.selected);
  const engine = useRef<ChartEngine | null>(null);
  const [ready, setReady] = useState<ChartEngine | null>(null);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const onEngine = (e: ChartEngine | null) => {
    engine.current = e;
    setReady(e);
  };

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    api.meta()
      .then((meta) => {
        if (cancelled) return;
        useUi.getState().set({ meta });
        if (!Object.keys(meta.aggregations).length) { useUi.getState().set({ status: t('no_data') }); return; }
        return ready.init(meta);
      })
      .catch((e: Error) => useUi.getState().set({ status: t('err') + e.message }));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <div className="flex h-full flex-col">
      <Toolbar engine={ready} />
      <main className="relative flex min-h-0 flex-1">
        <ChartView onEngine={onEngine} />
        {/* desktop: docked panel; narrow screens: overlay only while a candle is selected */}
        {side && (wide || selected) && <SidePanel overlay={!wide} />}
      </main>
    </div>
  );
}
