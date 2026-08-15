/**
 * Theme: dark, light, or follow the system.
 *
 * The choice is written to <html data-theme> and remembered in localStorage.
 * allwyn.css defines its tokens so that no stored value means "follow the
 * system", which is why "system" removes the attribute rather than setting it.
 */

const STORAGE_KEY = 'allwyn.theme';
// Dark first: with nothing stored the page is dark, whatever the desktop says.
const ORDER = ['dark', 'light', 'system'];
const LABELS = { system: 'Auto', dark: 'Dark', light: 'Light' };
const DEFAULT = 'dark';

export function readTheme() {
    const stored = localStorage.getItem(STORAGE_KEY);
    return ORDER.includes(stored) ? stored : DEFAULT;
}

export function applyTheme(theme) {
    // Always stamp the attribute: allwyn.css treats a bare :root as dark, so
    // "system" has to say so explicitly to opt back into the media query.
    document.documentElement.setAttribute('data-theme', theme);
}

/** Wire a button that cycles dark -> light -> auto, labelled with the next. */
export function initTheme(button) {
    let theme = readTheme();
    applyTheme(theme);

    // The button is labelled with what clicking it does, not with the theme you
    // are already looking at.
    const paint = () => {
        if (!button) return;
        const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
        button.textContent = LABELS[next];
        button.setAttribute('aria-label', `Switch to ${LABELS[next].toLowerCase()} theme`);
        button.setAttribute('title', `Currently ${LABELS[theme].toLowerCase()}`);
    };
    paint();

    button?.addEventListener('click', () => {
        theme = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
        if (theme === DEFAULT) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, theme);
        applyTheme(theme);
        paint();
    });
}
