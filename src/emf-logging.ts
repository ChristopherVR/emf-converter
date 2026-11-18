/**
 * Debug logging for the EMF/WMF converter.
 */

export const DEBUG_EMF = false;

export const emfLog = (...args: unknown[]): void => {
	if (DEBUG_EMF) {
		console.log('[emf-debug]', ...args);
	}
};

export const emfWarn = (...args: unknown[]): void => {
	if (DEBUG_EMF) {
		console.warn('[emf-debug]', ...args);
	}
};
