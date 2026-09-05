import type { AudioChannelBitrates, AutoDenoiseThresholds, GradfunLevelParams, JobSettings, NlmeansLevelParams } from "../types";
import type { GpuDevice, SettingsCodePanelElement, SettingsCodePanelOptions } from "../ui/models";
import { encodeSettingsCodeRequest } from "../api/client";
import { CHANNELS, ENCODERS, ENCODER_HELP, ENCODER_IDS, PARAM_LEVELS } from "../config/options";
import { clampFloat, clampInt, forceOdd } from "./job-render";
import { byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";

const SUBTITLE_TARGET_TYPES = ["full", "honorifics", "forced", "sdh", "commentary"] as const;

export function wireEncoderControls(prefix: "default" | "job", settings: JobSettings): void {
	const id = (s: string) => byId(`${prefix}-${s}`) as HTMLElement;

	const applyVisibility = () => {
		const def = ENCODERS[settings.encoder] || ENCODERS["svt-av1-essential"];
		const direct = !def.usesAutoBoost;
		id("abe-controls").style.display = direct ? "none" : "";
		id("manual-controls").style.display = direct ? "" : "none";
		// skip-boosting is an ABE concept - hide it for direct encoders if present
		const sb = byId(`${prefix}-skip-boosting`);
		const sbGroup = sb.closest<HTMLElement>(".setting-group");
		if (sbGroup) sbGroup.style.display = direct ? "none" : "";
	};

	// Encoder picker (render labels, store ids)
	const encEl = id("encoder");
	encEl.innerHTML = "";
	ENCODER_IDS.forEach((eid) => {
		const pill = document.createElement("div");
		pill.className = `radio-pill${eid === settings.encoder ? " selected" : ""}`;
		pill.textContent = ENCODERS[eid].label;
		pill.onclick = () => {
			encEl.querySelectorAll(".radio-pill").forEach((p) => p.classList.remove("selected"));
			pill.classList.add("selected");
			settings.encoder = eid;
			const help = byId(`${prefix}-encoder-help`);
			if (help) help.textContent = ENCODER_HELP[eid] || "";
			// seed manual appState.defaults if unset
			if (settings.manualCrf == null) settings.manualCrf = ENCODERS[eid].defaultCrf;
			if (settings.manualPreset == null) settings.manualPreset = ENCODERS[eid].defaultPreset;
			syncManual();
			applyVisibility();
		};
		encEl.appendChild(pill);
	});
	const help = byId(`${prefix}-encoder-help`);
	if (help) help.textContent = ENCODER_HELP[settings.encoder] || "";

	// Manual CRF (slider + number kept in sync) and preset slider
	const crfSlider = byId<HTMLInputElement>(`${prefix}-crf-slider`),
		crfInput = byId<HTMLInputElement>(`${prefix}-crf-input`),
		crfVal = id("crf-val");
	const presetSlider = byId<HTMLInputElement>(`${prefix}-preset-slider`),
		presetVal = id("preset-val");
	function syncManual() {
		const crf = settings.manualCrf ?? 24;
		const preset = settings.manualPreset ?? 4;
		crfSlider.value = String(crf);
		crfInput.value = String(crf);
		if (crfVal) crfVal.textContent = `(${crf})`;
		presetSlider.value = String(preset);
		if (presetVal) presetVal.textContent = `(${preset})`;
	}
	const setCrf = (v: number | string) => {
		v = Math.min(70, Math.max(1, Math.round(+v || 0)));
		settings.manualCrf = v;
		syncManual();
	};
	crfSlider.oninput = () => setCrf(crfSlider.value);
	crfInput.oninput = () => setCrf(crfInput.value);
	presetSlider.oninput = () => {
		settings.manualPreset = Math.min(13, Math.max(-1, Math.round(+presetSlider.value || 0)));
		if (presetVal) presetVal.textContent = `(${settings.manualPreset})`;
	};

	syncManual();
	applyVisibility();
}

export function mountSettingsCodePanel(container: SettingsCodePanelElement | null, opts: SettingsCodePanelOptions): void {
	if (!container) return;
	if (container._codeTimer) if (container._codeTimer) clearInterval(container._codeTimer);
	container._codeTimer = null;
	container.innerHTML = "";

	const label = document.createElement("label");
	label.textContent = "Settings Code";
	container.appendChild(label);

	const hint = document.createElement("div");
	hint.className = "lang-filter-hint";
	hint.innerHTML =
		"A compact, shareable code for these exact settings, also written to every encoded file's <code>SETTINGS</code> tag. Paste one in to reproduce a setup.";
	container.appendChild(hint);

	const exportRow = document.createElement("div");
	exportRow.className = "settings-code-row";
	const codeField = document.createElement("input");
	codeField.type = "text";
	codeField.readOnly = true;
	codeField.className = "settings-code-field";
	exportRow.appendChild(codeField);
	const copyBtn = document.createElement("button");
	copyBtn.type = "button";
	copyBtn.className = "btn btn-ghost btn-small";
	copyBtn.textContent = "\u00A0Copy\u00A0";
	exportRow.appendChild(copyBtn);
	container.appendChild(exportRow);

	const importRow = document.createElement("div");
	importRow.className = "settings-code-row";
	const importField = document.createElement("input");
	importField.type = "text";
	importField.className = "settings-code-field";
	importField.placeholder = "Paste a code (RE1...) to import";
	importRow.appendChild(importField);
	const importBtn = document.createElement("button");
	importBtn.type = "button";
	importBtn.className = "btn btn-primary btn-small";
	importBtn.textContent = "Import";
	importRow.appendChild(importBtn);
	container.appendChild(importRow);

	const status = document.createElement("div");
	status.className = "settings-code-status";
	container.appendChild(status);

	let lastSerialized: string | null = null;
	const refresh = async () => {
		const settings = opts.getSettings();
		if (!settings) {
			codeField.value = "—";
			lastSerialized = null;
			return;
		}
		lastSerialized = JSON.stringify(settings);
		codeField.value = (await encodeSettingsCodeRequest(settings)) || "—";
	};

	// Live-update the displayed code as other fields change. The edit callbacks
	// only mutate the settings object, so poll for changes and hit the server
	// solely when something actually changed.
	container._codeTimer = setInterval(async () => {
		if (!container.isConnected) {
			if (container._codeTimer) clearInterval(container._codeTimer);
			container._codeTimer = null;
			return;
		}
		const settings = opts.getSettings();
		if (!settings) return;
		const serialized = JSON.stringify(settings);
		if (serialized === lastSerialized) return;
		lastSerialized = serialized;
		codeField.value = (await encodeSettingsCodeRequest(settings)) || "—";
	}, 500);

	copyBtn.onclick = async () => {
		await refresh();
		try {
			await navigator.clipboard.writeText(codeField.value);
			copyBtn.textContent = "Copied";
			setTimeout(() => (copyBtn.textContent = "\u00A0Copy\u00A0"), 1200);
		} catch {
			codeField.select();
		}
	};

	importBtn.onclick = async () => {
		const code = importField.value.trim();
		if (!code) return;
		importBtn.disabled = true;
		status.textContent = "";
		status.className = "settings-code-status";
		try {
			const applied = await opts.onImport(code);
			importField.value = "";
			opts.onApplied(applied);
		} catch (err) {
			status.textContent = errorMessage(err) || "Invalid settings code";
			status.classList.add("err");
		} finally {
			importBtn.disabled = false;
		}
	};

	refresh();
}

export function clampToRange(v: number, min?: number, max?: number): number {
	if (typeof min === "number" && v < min) v = min;
	if (typeof max === "number" && v > max) v = max;
	return v;
}
export function renderRadioPills<T extends string>(container: HTMLElement, options: readonly T[], selected: T, onChange: (value: T) => void): void {
	container.innerHTML = "";
	options.forEach((opt) => {
		const pill = document.createElement("div");
		pill.className = `radio-pill${opt === selected ? " selected" : ""}`;
		pill.textContent = opt;
		pill.onclick = () => {
			container.querySelectorAll(".radio-pill").forEach((p) => p.classList.remove("selected"));
			pill.classList.add("selected");
			onChange(opt);
		};
		container.appendChild(pill);
	});
}

export function renderGpuDevicePicker(container: HTMLElement, devices: GpuDevice[], selectedId: string, onChange: (value: string) => void): void {
	container.innerHTML = "";
	if (!devices || devices.length === 0) {
		container.style.display = "none";
		return;
	}
	container.style.display = "";
	if (devices.length === 1) {
		const d = devices[0]!;
		const info = document.createElement("div");
		info.className = "gpu-device-info";
		info.textContent = `Device: ${d.deviceName.split("(")[0]?.trim()} (${d.id})`;
		container.appendChild(info);
		// ensure config still carries the id
		if (selectedId !== d.id) onChange(d.id);
		return;
	}
	for (const d of devices) {
		const label = document.createElement("label");
		label.className = "radio-pill";
		const input = document.createElement("input");
		input.type = "radio";
		input.name = container.id + "-radio";
		input.value = d.id;
		input.checked = d.id === selectedId;
		input.onchange = () => onChange(d.id);
		const text = document.createElement("span");
		text.textContent = `${d.deviceName.split("(")[0]?.trim()} (${d.id})`;
		label.appendChild(input);
		label.appendChild(text);
		container.appendChild(label);
	}
}

export function renderAutoThresholds(
	container: HTMLElement,
	thresholds: AutoDenoiseThresholds,
	onChange: (value: AutoDenoiseThresholds) => void,
	bounds: { min: number; max: number; step: number } = { min: 0, max: 1, step: 0.01 },
): void {
	container.innerHTML = "";
	const wrap = document.createElement("div");
	wrap.className = "auto-threshold-grid";
	for (const key of PARAM_LEVELS) {
		const label = document.createElement("label");
		label.className = "auto-threshold-row";
		const span = document.createElement("span");
		span.textContent = key;
		const input = document.createElement("input");
		input.type = "number";
		input.step = String(bounds.step);
		input.min = String(bounds.min);
		input.max = String(bounds.max);
		input.value = String(thresholds[key]);
		input.onchange = () => {
			const v = clampFloat(input.value, bounds.min, bounds.max);
			thresholds[key] = v;
			input.value = String(v);
			onChange({ ...thresholds });
		};
		label.appendChild(span);
		label.appendChild(input);
		wrap.appendChild(label);
	}
	container.appendChild(wrap);
}

export function renderBitrateInputs(
	container: HTMLElement,
	bitrates: AudioChannelBitrates,
	onChange: (channel: keyof AudioChannelBitrates, value: number) => void,
): void {
	container.innerHTML = "";
	CHANNELS.forEach((ch) => {
		const field = document.createElement("div");
		field.className = "bitrate-field";
		field.innerHTML = `
      <span>${ch.label}</span>
      <input type="number" min="32" max="1024" step="16" value="${bitrates[ch.key] || 128}" data-ch="${ch.key}">
    `;
		const input = field.querySelector<HTMLInputElement>("input")!;
		input.oninput = () => {
			onChange(ch.key, parseInt(input.value) || 128);
		};
		container.appendChild(field);
	});
}

export function renderLanguagePriorityInput(container: HTMLElement, value: string[], onChange: (value: string[]) => void, placeholder = "jpn, eng, *"): void {
	container.innerHTML = "";
	const input = document.createElement("input");
	input.type = "text";
	input.className = "lang-filter-input";
	input.placeholder = placeholder;
	input.value = (value || []).join(", ");

	const hint = document.createElement("div");
	hint.className = "lang-filter-hint";
	hint.textContent = "Ordered priority. Use * for everything else (alphabetical).";

	input.oninput = () =>
		onChange(
			input.value
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
		);

	container.appendChild(input);
	container.appendChild(hint);
}

export function renderCropLimit(container: HTMLElement, cropMode: string, value: number, onChange: (v: number) => void): void {
	container.innerHTML = "";
	// Show only when crop === "auto"
	if (cropMode !== "auto") {
		container.style.display = "none";
		return;
	}
	container.style.display = "";

	const pct = Math.round(value * 100);

	const row = document.createElement("div");
	row.className = "slider-row";

	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = "0";
	slider.max = "100";
	slider.step = "1";
	slider.value = String(pct);

	const numberInput = document.createElement("input");
	numberInput.type = "number";
	numberInput.min = "0";
	numberInput.max = "100";
	numberInput.step = "1";
	numberInput.className = "num-input";
	numberInput.value = String(pct);

	const update = (newPct: number) => {
		newPct = Math.min(100, Math.max(0, Math.round(newPct)));
		const newVal = newPct / 100;
		onChange(newVal);
		slider.value = String(newPct);
		numberInput.value = String(newPct);
	};

	slider.oninput = () => update(parseInt(slider.value, 10));
	numberInput.oninput = () => {
		let v = parseInt(numberInput.value, 10);
		if (isNaN(v)) v = 0;
		update(v);
	};

	row.appendChild(slider);
	row.appendChild(numberInput);
	container.appendChild(row);
}

export function renderDownscaleToggle(container: HTMLElement, checked: boolean, onChange: (value: boolean) => void): void {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = "\u00A0Downscale 4K to 1080p";

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

export function renderSkipBoostingToggle(container: HTMLElement, checked: boolean, onChange: (value: boolean) => void): void {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = "\u00A0Skip boosting";

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

export function renderNoPhaseInvToggle(container: HTMLElement, checked: boolean, onChange: (value: boolean) => void): void {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = "\u00A0Disable phase inversion (--no-phase-inv)";

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

export function renderDedupeSubtitlesToggle(container: HTMLElement, checked: boolean, onChange: (value: boolean) => void): void {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = "\u00A0Keep one subtitle per language and type";

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

export function renderKeepBestAudioChannelsToggle(container: HTMLElement, checked: boolean, onChange: (value: boolean) => void): void {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = "\u00A0Keep only highest channel layout per language";

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

export function renderRemoveCommentaryAudioToggle(container: HTMLElement, checked: boolean, onChange: (value: boolean) => void): void {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = "\u00A0Remove commentary audio tracks";

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

export function renderAudioLanguagesInput(container: HTMLElement, value: string[], onChange: (value: string[]) => void): void {
	container.innerHTML = "";

	const input = document.createElement("input");
	input.type = "text";
	input.className = "lang-filter-input";
	input.placeholder = "jpn, eng (empty = keep all)";
	input.value = (value || []).join(", ");

	const hint = document.createElement("div");
	hint.className = "lang-filter-hint";
	hint.textContent = "Comma-separated ISO codes. Empty keeps every track.";

	input.oninput = () =>
		onChange(
			input.value
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
		);

	container.appendChild(input);
	container.appendChild(hint);
}

export function renderLanguageFilterInput(container: HTMLElement, value: string[], onChange: (value: string[]) => void): void {
	container.innerHTML = "";

	const input = document.createElement("input");
	input.type = "text";
	input.className = "lang-filter-input";
	input.placeholder = "jpn, eng (empty = keep all)";
	input.value = (value || []).join(", ");

	const hint = document.createElement("div");
	hint.className = "lang-filter-hint";
	hint.textContent = "Comma-separated ISO codes. Empty keeps every track.";

	input.oninput = () =>
		onChange(
			input.value
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
		);

	container.appendChild(input);
	container.appendChild(hint);
}

export function renderTranslationLanguagesInput(container: HTMLElement, value: string[], onChange: (value: string[]) => void): void {
	container.innerHTML = "";

	const label = document.createElement("label");
	label.textContent = "Target languages";
	container.appendChild(label);

	const input = document.createElement("input");
	input.type = "text";
	input.className = "lang-filter-input";
	input.placeholder = "eng, slv";
	input.value = (value || []).join(", ");

	const hint = document.createElement("div");
	hint.className = "lang-filter-hint";
	hint.textContent =
		"Comma-separated ISO codes. Every listed language should end up with a full subtitle: " +
		"if one is missing, it's translated with the LLM from an existing full subtitle.";

	input.oninput = () =>
		onChange(
			input.value
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
		);

	container.appendChild(input);
	container.appendChild(hint);
}

export function renderNlmeansParamsEditor(container: HTMLElement, params: NlmeansLevelParams, onChange: (value: NlmeansLevelParams) => void): void {
	container.innerHTML = "";
	const grid = document.createElement("div");
	grid.className = "nlmeans-params-grid";

	// Header row
	for (const label of ["", "s (strength)", "p (patch)", "r (research)"]) {
		const cell = document.createElement("div");
		cell.className = "nlmeans-params-header";
		cell.textContent = label;
		grid.appendChild(cell);
	}

	for (const level of PARAM_LEVELS) {
		const labelCell = document.createElement("div");
		labelCell.className = "nlmeans-params-label";
		labelCell.textContent = level;
		grid.appendChild(labelCell);

		// s : float [1.0, 30.0]
		const sInput = document.createElement("input");
		sInput.type = "number";
		sInput.step = "0.1";
		sInput.min = "1";
		sInput.max = "30";
		sInput.value = String(params[level].s);
		sInput.onchange = () => {
			const v = clampFloat(sInput.value, 1.0, 30.0);
			params[level].s = v;
			sInput.value = String(v);
			onChange(params);
		};
		grid.appendChild(sInput);

		// p : odd int [1, 99]
		const pInput = document.createElement("input");
		pInput.type = "number";
		pInput.step = "2";
		pInput.min = "1";
		pInput.max = "99";
		pInput.value = String(params[level].p);
		pInput.onchange = () => {
			const v = forceOdd(clampInt(pInput.value, 1, 99));
			params[level].p = v;
			pInput.value = String(v);
			onChange(params);
		};
		grid.appendChild(pInput);

		// r : odd int [1, 99]
		const rInput = document.createElement("input");
		rInput.type = "number";
		rInput.step = "2";
		rInput.min = "1";
		rInput.max = "99";
		rInput.value = String(params[level].r);
		rInput.onchange = () => {
			const v = forceOdd(clampInt(rInput.value, 1, 99));
			params[level].r = v;
			rInput.value = String(v);
			onChange(params);
		};
		grid.appendChild(rInput);
	}

	container.appendChild(grid);
}

export function renderGradfunParamsEditor(container: HTMLElement, params: GradfunLevelParams, onChange: (value: GradfunLevelParams) => void): void {
	container.innerHTML = "";
	const grid = document.createElement("div");
	grid.className = "gradfun-params-grid";

	// Header row
	for (const label of ["", "strength", "radius"]) {
		const cell = document.createElement("div");
		cell.className = "gradfun-params-header";
		cell.textContent = label;
		grid.appendChild(cell);
	}

	for (const level of PARAM_LEVELS) {
		const labelCell = document.createElement("div");
		labelCell.className = "gradfun-params-label";
		labelCell.textContent = level;
		grid.appendChild(labelCell);

		// strength : float [0.51, 64]
		const sInput = document.createElement("input");
		sInput.type = "number";
		sInput.step = "0.1";
		sInput.min = "0.51";
		sInput.max = "64";
		sInput.value = String(params[level].strength);
		sInput.onchange = () => {
			const v = clampFloat(sInput.value, 0.51, 64);
			params[level].strength = v;
			sInput.value = String(v);
			onChange(params);
		};
		grid.appendChild(sInput);

		// radius : int [8, 32]
		const rInput = document.createElement("input");
		rInput.type = "number";
		rInput.step = "1";
		rInput.min = "8";
		rInput.max = "32";
		rInput.value = String(params[level].radius);
		rInput.onchange = () => {
			const v = clampInt(rInput.value, 8, 32);
			params[level].radius = v;
			rInput.value = String(v);
			onChange(params);
		};
		grid.appendChild(rInput);
	}

	container.appendChild(grid);
}

export function renderSubtitleLangDetectControl(
	container: HTMLElement,
	value: "enabled" | "und-only" | "disabled",
	onChange: (value: "enabled" | "und-only" | "disabled") => void,
): void {
	container.innerHTML = "";
	const modes: { value: "enabled" | "und-only" | "disabled"; label: string }[] = [
		{ value: "enabled", label: "Enabled" },
		{ value: "und-only", label: "Only if language undefined" },
		{ value: "disabled", label: "Disabled" },
	];

	const label = document.createElement("label");
	label.className = "toggle-label";

	const span = document.createElement("span");
	span.textContent = "Language detector\u00A0";

	const select = document.createElement("select");
	select.className = "select-input";
	for (const m of modes) {
		const o = document.createElement("option");
		o.value = m.value;
		o.textContent = m.label;
		if (m.value === value) o.selected = true;
		select.appendChild(o);
	}
	select.onchange = () => onChange(select.value as "enabled" | "und-only" | "disabled");

	label.appendChild(span);
	label.appendChild(select);
	container.appendChild(label);
}

export function renderSubtitleConfidenceControl(container: HTMLElement, value: number, onChange: (value: number) => void): void {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const span = document.createElement("span");
	span.textContent = "Min detector confidence\u00A0";

	const input = document.createElement("input");
	input.type = "number";
	input.min = "0";
	input.max = "100";
	input.step = "1";
	input.className = "num-input";
	input.value = String(Math.round((value ?? 0.05) * 100));

	const pct = document.createElement("span");
	pct.textContent = "\u00A0%";

	input.oninput = () => {
		let v = parseFloat(input.value);
		if (!Number.isFinite(v)) v = 5;
		v = Math.min(100, Math.max(0, v));
		onChange(v / 100);
	};

	label.appendChild(span);
	label.appendChild(input);
	label.appendChild(pct);
	container.appendChild(label);
}

export function renderDetectSignsSongsToggle(container: HTMLElement, checked: boolean, onChange: (value: boolean) => void): void {
	renderSimpleToggle(container, checked, "\u00A0Detect Signs & Songs tracks", onChange);
}

export function renderDetectSDHToggle(container: HTMLElement, checked: boolean, onChange: (value: boolean) => void): void {
	renderSimpleToggle(container, checked, "\u00A0Detect SDH tracks", onChange);
}

export function renderDetectHonorificsToggle(container: HTMLElement, checked: boolean, onChange: (value: boolean) => void): void {
	renderSimpleToggle(container, checked, "\u00A0Detect Honorifics tracks", onChange);
}

export function renderLabeledToggle(container: HTMLElement, checked: boolean, label: string, onChange: (v: boolean) => void): void {
	renderSimpleToggle(container, checked, `\u00A0${label}`, onChange);
}

export function renderNumberControl(
	container: HTMLElement,
	label: string,
	value: number,
	opts: { min: number; max: number; step: number },
	onChange: (v: number) => void,
): void {
	container.innerHTML = "";
	const wrap = document.createElement("label");
	wrap.className = "toggle-label";

	const span = document.createElement("span");
	span.textContent = `${label}\u00A0`;

	const input = document.createElement("input");
	input.type = "number";
	input.min = String(opts.min);
	input.max = String(opts.max);
	input.step = String(opts.step);
	input.className = "num-input";
	input.value = String(value);
	input.oninput = () => {
		let v = parseFloat(input.value);
		if (!Number.isFinite(v)) v = value;
		v = Math.min(opts.max, Math.max(opts.min, v));
		onChange(v);
	};

	wrap.appendChild(span);
	wrap.appendChild(input);
	container.appendChild(wrap);
}

function renderSimpleToggle(container: HTMLElement, checked: boolean, labelText: string, onChange: (value: boolean) => void): void {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = labelText;

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

/** Multi-select checkboxes for the track types ASS font-restyle applies to. */
export function renderSubtitleStyleTargets(container: HTMLElement, value: string[], onChange: (v: string[]) => void): void {
	container.innerHTML = "";
	const set = new Set(value);
	SUBTITLE_TARGET_TYPES.forEach((t) => {
		const label = document.createElement("label");
		label.className = "toggle-label";
		const input = document.createElement("input");
		input.type = "checkbox";
		input.checked = set.has(t);
		input.onchange = () => {
			if (input.checked) set.add(t);
			else set.delete(t);
			onChange([...set]);
		};
		const span = document.createElement("span");
		span.textContent = `\u00A0${t}`;
		label.appendChild(input);
		label.appendChild(span);
		container.appendChild(label);
	});
}

/** <select> of fonts from /config/fonts. Always keeps `value` selectable so an imported name isn't lost. */
export function renderFontDropdown(container: HTMLElement, value: string, fonts: { label: string }[], onChange: (v: string) => void): void {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";
	const span = document.createElement("span");
	span.textContent = "Font group\u00A0";
	const select = document.createElement("select");
	select.className = "select-input";

	const seen = new Set<string>();
	const names: string[] = [];
	if (value) {
		names.push(value);
		seen.add(value);
	}
	for (const f of fonts)
		if (!seen.has(f.label)) {
			names.push(f.label);
			seen.add(f.label);
		}

	if (names.length === 0) {
		const o = document.createElement("option");
		o.value = "";
		o.textContent = "No font groups found in /config/fonts";
		select.appendChild(o);
		select.disabled = true;
	} else {
		for (const name of names) {
			const o = document.createElement("option");
			o.value = name;
			o.textContent = name;
			if (name === value) o.selected = true;
			select.appendChild(o);
		}
	}
	select.onchange = () => onChange(select.value);
	label.appendChild(span);
	label.appendChild(select);
	container.appendChild(label);
}

/** Free-text control. */
export function renderTextControl(container: HTMLElement, label: string, value: string, placeholder: string, onChange: (v: string) => void): void {
	container.innerHTML = "";
	const wrap = document.createElement("label");
	wrap.className = "toggle-label";
	const span = document.createElement("span");
	span.textContent = `${label}\u00A0`;
	const input = document.createElement("input");
	input.type = "text";
	input.className = "lang-filter-input";
	input.placeholder = placeholder;
	input.value = value;
	input.oninput = () => onChange(input.value);
	wrap.appendChild(span);
	wrap.appendChild(input);
	container.appendChild(wrap);
}

/** Free-password control. */
export function renderPasswordControl(container: HTMLElement, label: string, value: string, placeholder: string, onChange: (v: string) => void): void {
	container.innerHTML = "";
	const wrap = document.createElement("label");
	wrap.className = "toggle-label";
	const span = document.createElement("span");
	span.textContent = `${label}\u00A0`;
	const input = document.createElement("input");
	input.type = "password";
	input.className = "lang-filter-input";
	input.placeholder = placeholder;
	input.value = value;
	input.oninput = () => onChange(input.value);
	wrap.appendChild(span);
	wrap.appendChild(input);
	container.appendChild(wrap);
}

export function renderSelectControl(
	container: HTMLElement,
	labelText: string,
	options: readonly string[],
	value: string,
	onChange: (value: string) => void,
): void {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const span = document.createElement("span");
	span.textContent = `${labelText}\u00A0`;

	const select = document.createElement("select");
	select.className = "select-input";
	for (const opt of options) {
		const o = document.createElement("option");
		o.value = opt;
		o.textContent = opt;
		if (opt === value) o.selected = true;
		select.appendChild(o);
	}
	select.onchange = () => onChange(select.value);

	label.appendChild(span);
	label.appendChild(select);
	container.appendChild(label);
}
