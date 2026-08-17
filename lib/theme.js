// SPDX-FileCopyrightText: 2026 Denys Lysenok
//
// SPDX-License-Identifier: GPL-2.0-or-later

// Which palette a surface needs, read off the colour its theme paints text
// with. gi-free, so the decision is testable without a shell.

/**
 * WCAG relative luminance of an sRGB colour: 0 for black, 1 for white.
 * @param {{red: number, green: number, blue: number}} color channels, 0-255
 * @returns {number}
 */
export function relativeLuminance({red, green, blue}) {
    const [r, g, b] = [red, green, blue].map(channel => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Dark text means a light surface, whatever theme or variant produced it.
 * @param {{red: number, green: number, blue: number}} foreground
 * @returns {'light' | 'dark'} the names gnome-shell gives its own stylesheets
 */
export function styleVariant(foreground) {
    return relativeLuminance(foreground) < 0.5 ? 'light' : 'dark';
}
