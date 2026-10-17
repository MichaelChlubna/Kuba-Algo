import { useEffect, useRef } from 'react';
import { ChartEngine } from '../chart/engine';
import { useT } from '../hooks';

/** Chart canvas (redrawn on view / data changes) + overlay canvas (crosshair) + tooltip. */
export function ChartView({ onEngine }: { onEngine: (e: ChartEngine | null) => void }) {
  const t = useT();
  const chart = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const e = new ChartEngine(chart.current!, overlay.current!, tip.current!);
    onEngine(e);
    return () => { e.dispose(); onEngine(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative min-w-0 flex-1">
      <canvas ref={chart} className="absolute inset-0 block h-full w-full" />
      <canvas ref={overlay} className="absolute inset-0 block h-full w-full cursor-crosshair" />
      <div ref={tip} className="tooltip" hidden />
      <div className="pointer-events-none absolute left-2 top-1.5 hidden text-[11px] text-help md:block">{t('help')}</div>
    </div>
  );
}
