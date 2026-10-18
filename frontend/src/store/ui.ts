// Transient UI state shared between the chart engine and the React components (not persisted).
import { create } from 'zustand';
import type { CandleFull, LiveStatus, Meta } from '../api/types';

export interface UiState {
  meta: Meta | null;
  status: string;
  /** selected candle (light columns, plus all columns once `full`) */
  selected: (CandleFull & { _full?: boolean }) | null;
  dataRange: { from: string; to: string } | null; // loaded UTC days
  rangeFrom: string;
  rangeTo: string;
  cellMode: 'text' | 'cells' | 'candles';
  live: LiveStatus | null;
  set: (patch: Partial<Omit<UiState, 'set'>>) => void;
}

export const useUi = create<UiState>()((set) => ({
  meta: null, status: '', selected: null, dataRange: null, rangeFrom: '', rangeTo: '', cellMode: 'candles', live: null,
  set: (patch) => set(patch),
}));
