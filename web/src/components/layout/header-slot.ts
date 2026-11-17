import { createContext, useContext } from 'react';

/**
 * DOM slot in the app header that a view can render its own toolbar into.
 *
 * Design mode owns the header: the preview controls (screens, device size,
 * versions, edit, code, save) are more useful up there than the inspector
 * tabs, so ChatView's design layout supplies this slot and DesignPreview
 * portals its toolbar into it. Views that get no slot render in place.
 */
export const HeaderSlotContext = createContext<HTMLElement | null>(null);

export const useHeaderSlot = () => useContext(HeaderSlotContext);
