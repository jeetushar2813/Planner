// Colour themes. The colours themselves live in css/themes.css; this file only knows the
// names, remembers the choice in this browser, and sets <html data-theme="...">.
// A person's choice is also stored on their account (store.js), so it follows them to other
// devices. "auto" matches the device's light or dark setting (no attribute at all).
//
// Keep this list, css/themes.css and the "theme" list in firestore.rules in step.

export const THEMES = [
  { id: 'auto', label: 'Match my device', hint: 'Light or dark, following your device' },
  { id: 'light', label: 'Light', hint: 'Clean and white' },
  { id: 'dark', label: 'Dark', hint: 'Easy on the eyes at night' },
  { id: 'corporate', label: 'Corporate', hint: 'Business-like, navy sidebar' },
  { id: 'blue', label: 'Monochrome blue', hint: 'Calm, every surface in blue' },
  { id: 'slate', label: 'Slate', hint: 'Quiet cool greys' },
  { id: 'colourful', label: 'Colourful', hint: 'Warm and playful' },
  { id: 'purple', label: 'Purple', hint: 'Soft purple' },
  { id: 'midnight', label: 'Midnight purple', hint: 'Dark purple for night owls' },
  { id: 'forest', label: 'Forest', hint: 'Fresh greens' }
];

export const DEFAULT_THEME = 'auto';
export const isTheme = (id) => THEMES.some((t) => t.id === id);

const KEY = 'planner-theme';

export function savedTheme() {
  try {
    const value = localStorage.getItem(KEY);
    return isTheme(value) ? value : DEFAULT_THEME;
  } catch { return DEFAULT_THEME; }
}

// Shows a theme now and remembers it on this device. Unknown names fall back to the default.
export function applyTheme(id, { remember = true } = {}) {
  const theme = isTheme(id) ? id : DEFAULT_THEME;
  const root = document.documentElement;
  if (theme === DEFAULT_THEME) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  if (remember) {
    try { localStorage.setItem(KEY, theme); } catch { /* storage blocked: the choice lasts for this visit only */ }
  }
  return theme;
}

export const currentTheme = () => document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
