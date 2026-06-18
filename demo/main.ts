/**
 * Interactive in-browser demo for emf-converter.
 *
 * Loads an EMF or WMF file the user picks (or drops), reads it as an
 * ArrayBuffer, dispatches to the matching converter based on extension /
 * magic bytes, and renders the resulting PNG data URL into an <img>.
 *
 * The library is imported straight from source so `bun build` bundles a
 * single browser-ready `main.js` for GitHub Pages.
 *
 * @module demo/main
 */

import { convertEmfToDataUrl, convertWmfToDataUrl } from '../src/index';

// ---------------------------------------------------------------------------
// Element lookup helpers
// ---------------------------------------------------------------------------

/** Resolve a required element by id, throwing if the markup drifted. */
function requireEl<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (el === null) {
		throw new Error(`demo: missing #${id} element`);
	}
	return el as T;
}

const fileInput = requireEl<HTMLInputElement>('file-input');
const dropZone = requireEl<HTMLLabelElement>('drop-zone');
const convertButton = requireEl<HTMLButtonElement>('convert-button');
const statusEl = requireEl<HTMLParagraphElement>('status');
const outputImage = requireEl<HTMLImageElement>('output-image');
const outputPlaceholder = requireEl<HTMLDivElement>('output-placeholder');
const metaName = requireEl<HTMLSpanElement>('meta-name');
const metaSize = requireEl<HTMLSpanElement>('meta-size');
const metaTime = requireEl<HTMLSpanElement>('meta-time');
const metaUrlLen = requireEl<HTMLSpanElement>('meta-url-len');
const metaPanel = requireEl<HTMLDivElement>('meta-panel');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The currently selected file, retained so the Convert button can re-run. */
let selectedFile: File | null = null;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Human-readable byte size, e.g. `12.3 KB`. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const kb = bytes / 1024;
	if (kb < 1024) {
		return `${kb.toFixed(1)} KB`;
	}
	return `${(kb / 1024).toFixed(2)} MB`;
}

/** Detect the metafile kind from the EMF signature, falling back to the name. */
function detectKind(buffer: ArrayBuffer, fileName: string): 'emf' | 'wmf' {
	const bytes = new Uint8Array(buffer);
	// EMF records begin with iType=1 (EMR_HEADER) then nSize; offset 40 holds
	// the ASCII signature " EMF" (0x464D4520 little-endian).
	if (bytes.length >= 44) {
		const sig =
			bytes[40] | (bytes[41] << 8) | (bytes[42] << 16) | (bytes[43] << 24);
		if (sig === 0x464d4520) {
			return 'emf';
		}
	}
	// Placeable WMF magic 0x9AC6CDD7, or fall back to the file extension.
	if (fileName.toLowerCase().endsWith('.wmf')) {
		return 'wmf';
	}
	return 'emf';
}

// ---------------------------------------------------------------------------
// UI state transitions
// ---------------------------------------------------------------------------

function setStatus(message: string, tone: 'idle' | 'busy' | 'ok' | 'error'): void {
	statusEl.textContent = message;
	statusEl.dataset.tone = tone;
}

function showError(message: string): void {
	setStatus(message, 'error');
	outputImage.hidden = true;
	outputPlaceholder.hidden = false;
	metaPanel.hidden = true;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

async function convertSelectedFile(): Promise<void> {
	if (selectedFile === null) {
		setStatus('Choose an .emf or .wmf file first.', 'idle');
		return;
	}

	const file = selectedFile;
	convertButton.disabled = true;
	setStatus(`Converting ${file.name}…`, 'busy');

	try {
		const buffer = await file.arrayBuffer();
		const kind = detectKind(buffer, file.name);

		const start = performance.now();
		const dataUrl =
			kind === 'wmf'
				? await convertWmfToDataUrl(buffer)
				: await convertEmfToDataUrl(buffer);
		const elapsed = performance.now() - start;

		if (dataUrl === null) {
			showError(
				`Conversion returned null — the file may not be a valid ${kind.toUpperCase()} metafile.`,
			);
			return;
		}

		outputImage.src = dataUrl;
		outputImage.hidden = false;
		outputPlaceholder.hidden = true;

		metaName.textContent = file.name;
		metaSize.textContent = formatBytes(file.size);
		metaTime.textContent = `${elapsed.toFixed(1)} ms`;
		metaUrlLen.textContent = `${dataUrl.length.toLocaleString()} chars`;
		metaPanel.hidden = false;

		setStatus(`Converted as ${kind.toUpperCase()} in ${elapsed.toFixed(1)} ms.`, 'ok');
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		showError(`Conversion failed: ${detail}`);
	} finally {
		convertButton.disabled = false;
	}
}

// ---------------------------------------------------------------------------
// File selection wiring
// ---------------------------------------------------------------------------

/** Adopt a freshly chosen file and immediately convert it. */
function selectFile(file: File): void {
	selectedFile = file;
	convertButton.disabled = false;
	void convertSelectedFile();
}

fileInput.addEventListener('change', () => {
	const file = fileInput.files?.[0];
	if (file !== undefined) {
		selectFile(file);
	}
});

convertButton.addEventListener('click', () => {
	void convertSelectedFile();
});

// Drag-and-drop onto the label drop zone.
dropZone.addEventListener('dragover', (event) => {
	event.preventDefault();
	dropZone.dataset.dragging = 'true';
});

dropZone.addEventListener('dragleave', () => {
	delete dropZone.dataset.dragging;
});

dropZone.addEventListener('drop', (event) => {
	event.preventDefault();
	delete dropZone.dataset.dragging;
	const file = event.dataTransfer?.files?.[0];
	if (file !== undefined) {
		// Keep the native input in sync where the browser allows it.
		if (event.dataTransfer !== null) {
			fileInput.files = event.dataTransfer.files;
		}
		selectFile(file);
	}
});

setStatus('Ready — pick or drop an EMF/WMF file to convert.', 'idle');
