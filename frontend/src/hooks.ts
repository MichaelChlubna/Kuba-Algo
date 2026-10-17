import { useCallback, useSyncExternalStore } from 'react';
import { translate, type I18nKey } from './i18n';
import { useSettings } from './store/settings';

/** t(key, ...args) in the current UI language. */
export function useT() {
  const lang = useSettings((s) => s.lang);
  return useCallback((key: I18nKey, ...args: (string | number)[]) => translate(lang, key, ...args), [lang]);
}

/** true while the media query matches (e.g. desktop width). */
export function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia(query).matches,
  );
}
