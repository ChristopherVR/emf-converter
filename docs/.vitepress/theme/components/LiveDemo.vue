<script setup lang="ts">
/**
 * In-browser demo: pick or drop an EMF/WMF file, convert it to PNG, JPEG or SVG
 * with the library, show the result and offer it as a download. SVG output
 * can also be copied as a TSX component.
 *
 * The library is imported from the repository source on first use, so the
 * docs build does not depend on a published package.
 */
import { ref, watch } from 'vue';

type Format = 'png' | 'jpeg' | 'svg';
type Tone = 'idle' | 'busy' | 'ok' | 'error';

interface Result {
	dataUrl: string;
	fileName: string;
	fileSize: number;
	elapsedMs: number;
	format: Format;
	jsx: string | null;
}

const fileInput = ref<HTMLInputElement | null>(null);
const selectedFile = ref<File | null>(null);
const format = ref<Format>('png');
/** JPEG quality in percent (the library takes 0 to 1). */
const quality = ref(92);
const dragging = ref(false);
const busy = ref(false);
const status = ref('Select or drop an .emf or .wmf file.');
const tone = ref<Tone>('idle');
const result = ref<Result | null>(null);

function setStatus(message: string, nextTone: Tone): void {
	status.value = message;
	tone.value = nextTone;
}

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

/** Label used in messages only; conversion detects the format itself. */
function sniffKind(buffer: ArrayBuffer, fileName: string): 'EMF' | 'WMF' {
	const bytes = new Uint8Array(buffer);
	// EMR_HEADER carries the signature " EMF" (0x464D4520) at offset 40.
	if (bytes.length >= 44) {
		const sig = bytes[40] | (bytes[41] << 8) | (bytes[42] << 16) | (bytes[43] << 24);
		if (sig === 0x464d4520) {
			return 'EMF';
		}
	}
	return fileName.toLowerCase().endsWith('.wmf') ? 'WMF' : 'EMF';
}

/** PascalCase component name derived from the file name. */
function componentNameFor(fileName: string): string {
	const base = fileName
		.replace(/\.[^.]+$/, '')
		.replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c: string | undefined) => (c ?? '').toUpperCase());
	const name = base.charAt(0).toUpperCase() + base.slice(1);
	return /^[A-Z]/.test(name) ? name : `Metafile${name}`;
}

function baseName(fileName: string): string {
	return fileName.replace(/\.[^.]+$/, '');
}

async function convert(): Promise<void> {
	const file = selectedFile.value;
	if (file === null) {
		setStatus('Select an .emf or .wmf file first.', 'idle');
		return;
	}
	busy.value = true;
	setStatus(`Converting ${file.name}...`, 'busy');
	try {
		const lib = await import('../../../../src/index');
		const buffer = await file.arrayBuffer();
		const kind = sniffKind(buffer, file.name);
		const target = format.value;
		const start = performance.now();
		let dataUrl: string | null;
		let jsx: string | null = null;
		if (target === 'svg') {
			const tree = await lib.convertMetafileToSvgTree(buffer);
			dataUrl = tree ? lib.svgTreeToDataUrl(tree) : null;
			jsx = tree ? lib.svgTreeToJsx(tree, { componentName: componentNameFor(file.name) }) : null;
		} else if (target === 'jpeg') {
			dataUrl = await lib.convertMetafileToJpegDataUrl(buffer, { quality: quality.value / 100 });
		} else {
			dataUrl = await lib.convertMetafileToDataUrl(buffer);
		}
		const elapsedMs = performance.now() - start;
		if (dataUrl === null) {
			result.value = null;
			setStatus(`Conversion returned null. The file may not be a valid ${kind} metafile.`, 'error');
			return;
		}
		result.value = { dataUrl, fileName: file.name, fileSize: file.size, elapsedMs, format: target, jsx };
		setStatus(`Converted ${kind} to ${target.toUpperCase()} in ${elapsedMs.toFixed(1)} ms.`, 'ok');
	} catch (err) {
		result.value = null;
		setStatus(`Conversion failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
	} finally {
		busy.value = false;
	}
}

function selectFile(file: File): void {
	selectedFile.value = file;
	void convert();
}

function onFileChange(): void {
	const file = fileInput.value?.files?.[0];
	if (file !== undefined) {
		selectFile(file);
	}
}

function onDrop(event: DragEvent): void {
	dragging.value = false;
	const files = event.dataTransfer?.files;
	const file = files?.[0];
	if (file === undefined) {
		return;
	}
	if (fileInput.value !== null && files !== undefined) {
		fileInput.value.files = files;
	}
	selectFile(file);
}

async function copyJsx(): Promise<void> {
	const jsx = result.value?.jsx;
	if (!jsx) {
		return;
	}
	try {
		await navigator.clipboard.writeText(jsx);
		setStatus('TSX component copied to the clipboard.', 'ok');
	} catch {
		setStatus('The browser denied clipboard access.', 'error');
	}
}

/** File extension for downloads. */
function extensionFor(target: Format): string {
	return target === 'jpeg' ? 'jpg' : target;
}

watch([format, quality], () => {
	if (selectedFile.value !== null) {
		void convert();
	}
});
</script>

<template>
	<div class="live-demo">
		<div class="panel">
			<label
				class="drop-zone"
				:class="{ dragging }"
				@dragover.prevent="dragging = true"
				@dragleave="dragging = false"
				@drop.prevent="onDrop"
			>
				<span class="drop-title">Drop a file here or click to browse</span>
				<span class="drop-hint">.emf or .wmf</span>
				<input
					ref="fileInput"
					type="file"
					accept=".emf,.wmf,image/emf,image/wmf,image/x-emf,image/x-wmf"
					data-testid="file-input"
					@change="onFileChange"
				/>
			</label>
			<div class="controls">
				<fieldset class="format">
					<legend>Output</legend>
					<label><input v-model="format" type="radio" value="png" /> PNG</label>
					<label><input v-model="format" type="radio" value="jpeg" /> JPEG</label>
					<label><input v-model="format" type="radio" value="svg" /> SVG</label>
				</fieldset>
				<label v-if="format === 'jpeg'" class="quality">
					Quality
					<input v-model.lazy.number="quality" type="range" min="10" max="100" step="1" data-testid="jpeg-quality" />
					<span>{{ quality }}</span>
				</label>
				<button type="button" class="btn" :disabled="busy || selectedFile === null" @click="convert">
					Convert
				</button>
			</div>
			<p class="status" :data-tone="tone" role="status" data-testid="status">{{ status }}</p>
		</div>

		<div class="panel">
			<div class="output">
				<img v-if="result" :src="result.dataUrl" alt="Converted output" data-testid="output-image" />
				<span v-else class="placeholder">The converted image appears here.</span>
			</div>
			<template v-if="result">
				<dl class="meta">
					<dt>File</dt>
					<dd>{{ result.fileName }}</dd>
					<dt>Size</dt>
					<dd>{{ formatBytes(result.fileSize) }}</dd>
					<dt>Time</dt>
					<dd>{{ result.elapsedMs.toFixed(1) }} ms</dd>
					<dt>Data URL</dt>
					<dd>{{ result.dataUrl.length.toLocaleString() }} characters</dd>
				</dl>
				<div class="actions">
					<a class="btn" :href="result.dataUrl" :download="`${baseName(result.fileName)}.${extensionFor(result.format)}`">
						Download .{{ extensionFor(result.format) }}
					</a>
					<button v-if="result.jsx" type="button" class="btn alt" @click="copyJsx">Copy as TSX component</button>
				</div>
			</template>
		</div>
	</div>
</template>

<style scoped>
.live-demo {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 16px;
	margin: 16px 0;
}

@media (max-width: 720px) {
	.live-demo {
		grid-template-columns: 1fr;
	}
}

.panel {
	display: flex;
	flex-direction: column;
	gap: 12px;
	min-width: 0;
}

.drop-zone {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 4px;
	min-height: 200px;
	padding: 16px;
	border: 1px dashed var(--vp-c-divider);
	border-radius: 8px;
	background: var(--vp-c-bg-soft);
	cursor: pointer;
	text-align: center;
	transition: border-color 0.2s;
}

.drop-zone:hover,
.drop-zone.dragging {
	border-color: var(--vp-c-brand-1);
}

.drop-zone input {
	display: none;
}

.drop-title {
	font-weight: 500;
	color: var(--vp-c-text-1);
}

.drop-hint {
	font-size: 14px;
	color: var(--vp-c-text-2);
}

.controls {
	display: flex;
	align-items: center;
	gap: 16px;
	flex-wrap: wrap;
}

.format {
	display: flex;
	gap: 12px;
	margin: 0;
	padding: 0;
	border: 0;
	font-size: 14px;
}

.format legend {
	float: left;
	margin-right: 4px;
	color: var(--vp-c-text-2);
}

.quality {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font-size: 14px;
	color: var(--vp-c-text-2);
}

.quality span {
	min-width: 2.5em;
	font-variant-numeric: tabular-nums;
}

.format label {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	cursor: pointer;
}

.btn {
	display: inline-block;
	padding: 0 16px;
	line-height: 36px;
	font-size: 14px;
	font-weight: 500;
	border: 1px solid var(--vp-button-brand-border);
	border-radius: 20px;
	color: var(--vp-button-brand-text);
	background: var(--vp-button-brand-bg);
	text-decoration: none;
	cursor: pointer;
}

.btn:hover {
	background: var(--vp-button-brand-hover-bg);
}

.btn.alt {
	border-color: var(--vp-button-alt-border);
	color: var(--vp-button-alt-text);
	background: var(--vp-button-alt-bg);
}

.btn.alt:hover {
	background: var(--vp-button-alt-hover-bg);
}

.vp-doc a.btn {
	color: var(--vp-button-brand-text);
	text-decoration: none;
}

.btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.status {
	margin: 0;
	font-size: 14px;
	color: var(--vp-c-text-2);
}

.status[data-tone='ok'] {
	color: var(--vp-c-success-1);
}

.status[data-tone='error'] {
	color: var(--vp-c-danger-1);
}

.output {
	display: flex;
	align-items: center;
	justify-content: center;
	min-height: 200px;
	padding: 12px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	background: var(--vp-c-bg-alt);
	overflow: hidden;
}

.output img {
	max-width: 100%;
	max-height: 360px;
}

.placeholder {
	font-size: 14px;
	color: var(--vp-c-text-3);
}

.meta {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 2px 16px;
	margin: 0;
	font-size: 14px;
}

.meta dt {
	color: var(--vp-c-text-2);
}

.meta dd {
	margin: 0;
	word-break: break-word;
}

.actions {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
}
</style>
