/** Browser builds never load native packages or inspect the host filesystem. */
export async function loadNodeCanvasModule(): Promise<null> {
	return null;
}

export async function loadSystemFonts(): Promise<Uint8Array[]> {
	return [];
}
