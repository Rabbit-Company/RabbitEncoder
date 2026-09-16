import type { AdvancedTarget } from "../ui/models";
import type { FontOption } from "../api/client";
import type { JobSettings, StyleAppearance } from "../types";
import { DEFAULT_STYLE_APPEARANCE } from "../config/options";
import { fetchFonts, fetchGroupStyle, saveGroupStyle } from "../api/client";
import { renderFontDropdown, renderNumberControl, renderTextControl, renderLabeledToggle } from "./settings-controls";
import { renderFontPreview } from "./font-preview";
import { byId } from "../shared/dom";

interface AxisInfo {
	tag: string;
	min: number;
	default: number;
	max: number;
	name: string;
}

function resolveSettings(target: AdvancedTarget): JobSettings | null {
	if (target === "default") return window._tempDefaults ?? null;
	if (target === "job") return window._tempJobSettings ?? null;
	return null;
}

let state: {
	settings: JobSettings;
	label: string;
	style: Partial<StyleAppearance>;
	overrides: Record<string, Partial<StyleAppearance>>;
	scope: string; // "" = group global, else an override key
	keys: string[];
	fonts: FontOption[];
	dirty: boolean;
} | null = null;

function appearanceDefault(): StyleAppearance {
	return { ...DEFAULT_STYLE_APPEARANCE, fontAxes: { ...DEFAULT_STYLE_APPEARANCE.fontAxes } };
}

/** Effective merged appearance for the *current* scope (default <- global <- override). */
function effective(): StyleAppearance {
	const s = state!;
	const base = appearanceDefault();
	const withGlobal: StyleAppearance = { ...base, ...s.style, fontAxes: s.style.fontAxes ?? base.fontAxes };
	if (!s.scope) return withGlobal;
	const ov = s.overrides[s.scope] ?? {};
	return { ...withGlobal, ...ov, fontAxes: ov.fontAxes ?? withGlobal.fontAxes };
}

/** The object edits write into for the current scope. */
function target(): Partial<StyleAppearance> {
	const s = state!;
	if (!s.scope) return s.style;
	return (s.overrides[s.scope] ??= {});
}

function markDirty(): void {
	if (state) state.dirty = true;
	byId("sub-style-status").textContent = "Unsaved changes";
}

function axesForScope(): Map<string, AxisInfo> {
	const s = state!;
	const fam = s.fonts.find((f) => f.label === s.label);
	const matching = (fam?.faces ?? []).filter((face) => !s.scope || (face.keys ?? []).includes(s.scope));
	const pool = matching.length ? matching : (fam?.faces ?? []);
	const axes = new Map<string, AxisInfo>();
	for (const face of pool) for (const a of (face.axes ?? []) as AxisInfo[]) if (!axes.has(a.tag)) axes.set(a.tag, a);
	return axes;
}

function renderAxes(): void {
	const host = byId("sub-style-axes");
	host.innerHTML = "";
	const axes = axesForScope();
	const obj = target();
	if (axes.size === 0) {
		const help = document.createElement("div");
		help.className = "setting-help";
		help.textContent = "No variable axes for this scope's font.";
		host.appendChild(help);
		delete obj.fontAxes;
		return;
	}
	const eff = effective().fontAxes ?? {};
	obj.fontAxes ??= {};
	for (const tag of Object.keys(obj.fontAxes)) if (!axes.has(tag)) delete obj.fontAxes[tag];
	for (const [tag, a] of axes) {
		const group = document.createElement("div");
		group.className = "setting-group";
		host.appendChild(group);
		renderNumberControl(group, `${a.name} (${tag})`, eff[tag] ?? a.default, { min: a.min, max: a.max, step: tag === "wght" ? 1 : 0.5 }, (v) => {
			(obj.fontAxes ??= {})[tag] = v;
			markDirty();
			renderPreview();
		});
	}
}

function renderScope(): void {
	const s = state!;
	const host = byId("sub-style-scope");
	host.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";
	const span = document.createElement("span");
	span.textContent = "Edit scope\u00A0";
	const select = document.createElement("select");
	select.className = "select-input";
	const opts: { value: string; text: string }[] = [{ value: "", text: "Group global" }, ...s.keys.map((k) => ({ value: k, text: k }))];
	for (const o of opts) {
		const el = document.createElement("option");
		el.value = o.value;
		el.textContent = o.text;
		if (o.value === s.scope) el.selected = true;
		select.appendChild(el);
	}
	select.onchange = () => {
		s.scope = select.value;
		renderControls();
	};
	label.append(span, select);
	host.appendChild(label);
}

function renderControls(): void {
	const eff = effective();
	const t = target();
	const num = (id: string, lbl: string, key: keyof StyleAppearance, o: { min: number; max: number; step: number }) =>
		renderNumberControl(byId(id), lbl, eff[key] as number, o, (v) => {
			(t as any)[key] = v;
			markDirty();
			renderPreview();
		});
	const txt = (id: string, lbl: string, key: keyof StyleAppearance, ph: string) =>
		renderTextControl(byId(id), lbl, eff[key] as string, ph, (v) => {
			(t as any)[key] = v;
			markDirty();
			renderPreview();
		});

	num("sub-style-font-size", "Font size (px)", "fontSize", { min: 1, max: 400, step: 1 });
	num("sub-style-outline", "Outline (px)", "outline", { min: 0, max: 50, step: 0.5 });
	num("sub-style-shadow", "Shadow (px)", "shadow", { min: 0, max: 50, step: 0.5 });
	num("sub-style-margin-v", "Bottom margin (px)", "marginV", { min: 0, max: 1000, step: 1 });
	num("sub-style-margin-l", "Left margin (px)", "marginL", { min: 0, max: 1000, step: 1 });
	num("sub-style-margin-r", "Right margin (px)", "marginR", { min: 0, max: 1000, step: 1 });
	num("sub-style-alignment", "Alignment (numpad 1-9)", "alignment", { min: 1, max: 9, step: 1 });
	txt("sub-style-primary-colour", "Text colour", "primaryColour", "&H00FFFFFF");
	txt("sub-style-outline-colour", "Outline colour", "outlineColour", "&H00000000");
	txt("sub-style-back-colour", "Shadow colour", "backColour", "&H80000000");
	renderLabeledToggle(byId("sub-style-bold"), eff.bold ?? false, "Bold flag (leave off when using a weight axis)", (v) => {
		t.bold = v;
		markDirty();
		renderPreview();
	});

	renderScope();
	renderAxes();
	renderPreview();
}

function renderPreview(): void {
	renderFontPreview(byId("sub-style-preview"), { ...effective(), fontName: state!.label });
}

async function loadGroup(label: string): Promise<void> {
	const cfg = await fetchGroupStyle(label);
	state!.label = label;
	state!.style = cfg.style ?? {};
	state!.overrides = cfg.overrides ?? {};
	state!.keys = cfg.keys ?? [];
	state!.scope = "";
	state!.dirty = false;
	byId("sub-style-status").textContent = "";
	renderControls();
}

export function openSubStyleModal(target: AdvancedTarget): void {
	const settings = resolveSettings(target);
	if (!settings) return;
	const label = settings.fontGroup || "Noto Sans";
	state = { settings, label, style: {}, overrides: {}, scope: "", keys: [], fonts: [], dirty: false };

	byId("sub-style-modal-title").textContent = "Font group & style";
	byId("sub-style-status").textContent = "Loading...";
	renderFontDropdown(byId("sub-style-font"), label, [], () => {});

	fetchFonts().then((fonts) => {
		state!.fonts = fonts;
		renderFontDropdown(byId("sub-style-font"), state!.label, fonts, (v) => {
			settings.fontGroup = v; // persisted by the outer settings Save
			loadGroup(v);
		});
	});

	loadGroup(label);
	byId("sub-style-modal").style.display = "";
}

export async function saveCurrentGroupStyle(): Promise<void> {
	if (!state) return;
	byId("sub-style-status").textContent = "Saving...";
	const ok = await saveGroupStyle(state.label, { style: state.style, overrides: state.overrides });
	byId("sub-style-status").textContent = ok ? "Saved" : "Save failed";
	if (ok) {
		state.dirty = false;
		state.fonts = await fetchFonts();
	}
}

export function closeSubStyleModal(): void {
	byId("sub-style-modal").style.display = "none";
}
export function closeSubStyleModalIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeSubStyleModal();
}
