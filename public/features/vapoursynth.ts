import type { JobSettings, VsFilterEntry, VsParamSpec, VsPresetManifest } from "../types";
import { fetchVsDefaultEntry, fetchVsPresets } from "../api/client";
import { clampToRange, renderRadioPills } from "./settings-controls";

export function renderVsChainEditor(container: HTMLElement, settings: JobSettings): void {
	container.innerHTML = "";
	settings.vsFilters = settings.vsFilters || [];

	fetchVsPresets().then((presets) => {
		if (presets.length === 0) {
			const empty = document.createElement("div");
			empty.className = "vs-empty";
			empty.textContent = "No VapourSynth presets found.";
			container.appendChild(empty);
			return;
		}

		settings.vsFilters.forEach((entry, idx) => {
			const manifest = presets.find((p) => p.id === entry.presetId);
			if (!manifest) return;
			container.appendChild(renderVsChainEntry(manifest, entry, idx, settings));
		});

		const addRow = document.createElement("div");
		addRow.className = "vs-add-row";

		const select = document.createElement("select");
		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.textContent = "+ Add filter...";
		select.appendChild(placeholder);
		for (const p of presets) {
			const opt = document.createElement("option");
			opt.value = p.id;
			opt.textContent = `${p.name} (${p.source})`;
			select.appendChild(opt);
		}
		select.onchange = async () => {
			if (!select.value) return;
			const fresh = await fetchVsDefaultEntry(select.value);
			settings.vsFilters.push(fresh);
			renderVsChainEditor(container, settings);
		};

		addRow.appendChild(select);
		container.appendChild(addRow);
	});
}

export function renderVsChainEntry(manifest: VsPresetManifest, entry: VsFilterEntry, idx: number, settings: JobSettings): HTMLElement {
	const card = document.createElement("div");
	card.className = "vs-entry-card";

	const header = document.createElement("div");
	header.className = "vs-entry-header";

	const name = document.createElement("span");
	name.className = "vs-entry-name";
	name.textContent = manifest.name;
	header.appendChild(name);

	const badge = document.createElement("span");
	badge.className = `vs-entry-source ${manifest.source === "user" ? "user" : ""}`;
	badge.textContent = manifest.source;
	header.appendChild(badge);

	const removeBtn = document.createElement("button");
	removeBtn.className = "btn btn-ghost btn-small btn-remove";
	removeBtn.textContent = "Remove";
	removeBtn.onclick = () => {
		settings.vsFilters.splice(idx, 1);
		renderVsChainEditor(card.parentElement!, settings);
	};
	header.appendChild(removeBtn);
	card.appendChild(header);

	if (manifest.description) {
		const desc = document.createElement("div");
		desc.className = "vs-entry-description";
		desc.textContent = manifest.description;
		card.appendChild(desc);
	}

	const levelOptions = ["off", ...manifest.levels];
	const levelEl = document.createElement("div");
	levelEl.className = "radio-group";
	renderRadioPills(levelEl, levelOptions, entry.level || "off", (v) => {
		entry.level = v;
	});
	card.appendChild(levelEl);

	const editBtn = document.createElement("button");
	editBtn.className = "vs-entry-edit-btn";
	editBtn.type = "button";
	editBtn.textContent = "Edit values per level";

	const paramPanel = document.createElement("div");
	paramPanel.className = "vs-param-panel";
	paramPanel.style.display = "none";
	renderVsParamPanel(paramPanel, manifest, entry);

	editBtn.onclick = () => {
		const open = paramPanel.style.display !== "none";
		paramPanel.style.display = open ? "none" : "";
		editBtn.classList.toggle("open", !open);
	};

	card.appendChild(editBtn);
	card.appendChild(paramPanel);
	return card;
}

export function renderVsParamPanel(container: HTMLElement, manifest: VsPresetManifest, entry: VsFilterEntry): void {
	container.innerHTML = "";

	const grid = document.createElement("div");
	grid.className = "vs-param-grid";
	grid.style.gridTemplateColumns = `minmax(80px, auto) repeat(${manifest.levels.length}, 1fr)`;

	const corner = document.createElement("div");
	corner.className = "vs-param-header vs-param-header-corner";
	corner.textContent = "param";
	grid.appendChild(corner);
	for (const lvl of manifest.levels) {
		const h = document.createElement("div");
		h.className = "vs-param-header";
		h.textContent = lvl;
		grid.appendChild(h);
	}

	for (const spec of manifest.params) {
		const label = document.createElement("div");
		label.className = "vs-param-row-label";
		label.textContent = spec.label || spec.key;
		label.title = spec.key;
		grid.appendChild(label);

		for (const lvl of manifest.levels) {
			const cell = document.createElement("div");
			cell.className = "vs-param-cell";
			cell.appendChild(renderVsParamInput(spec, lvl, entry));
			grid.appendChild(cell);
		}

		if (spec.help) {
			const help = document.createElement("div");
			help.className = "vs-param-help";
			help.textContent = spec.help;
			grid.appendChild(help);
		}
	}

	container.appendChild(grid);
}

export function renderVsParamInput(spec: VsParamSpec, level: string, entry: VsFilterEntry): HTMLInputElement | HTMLSelectElement {
	entry.params = entry.params || {};
	entry.params[level] = entry.params[level] || {};
	const cur = entry.params[level][spec.key];

	if (spec.type === "bool") {
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.checked = !!cur;
		cb.onchange = () => {
			entry.params[level]![spec.key] = cb.checked;
		};
		return cb;
	}

	if (spec.type === "enum") {
		const sel = document.createElement("select");
		for (const v of spec.enum ?? []) {
			const opt = document.createElement("option");
			opt.value = v;
			opt.textContent = v;
			if (v === cur) opt.selected = true;
			sel.appendChild(opt);
		}
		sel.onchange = () => {
			entry.params[level]![spec.key] = sel.value;
		};
		return sel;
	}

	const input = document.createElement("input");
	input.type = "number";
	if (spec.min !== undefined) input.min = String(spec.min);
	if (spec.max !== undefined) input.max = String(spec.max);
	input.step = spec.step !== undefined ? String(spec.step) : spec.type === "int" ? "1" : "0.01";
	input.value = String(cur ?? spec.defaults[level]);
	input.onchange = () => {
		const n = parseFloat(input.value);
		if (!Number.isFinite(n)) return;
		const v = spec.type === "int" ? Math.round(n) : n;
		const clamped = clampToRange(v, spec.min, spec.max);
		entry.params[level]![spec.key] = clamped;
		input.value = String(clamped);
	};
	return input;
}
