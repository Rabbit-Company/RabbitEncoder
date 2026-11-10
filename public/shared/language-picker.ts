import { LANGUAGES, findLanguage, isLanguageCode, isListedLanguage, type LanguageEntry } from "./languages";

/**
 * Turns a text input holding language codes into a searchable picker.
 *
 *   data-language-picker   "single", "multi" (comma separated) or "ordered" (multi, drag to reorder)
 *   data-language-codes    "code3" writes ISO 639-2/B (jpn, ger) like ffprobe reports, "tag" writes BCP 47 (ja, de)
 *   data-language-variants "off" leaves out regional variants such as pt-BR
 *   data-language-any      offers "*", everything else
 *   data-language-empty    search placeholder while nothing is picked
 *
 * The input stays in the DOM, hidden, and keeps holding the value. Picks write it and fire
 * input and change on it, and assigning its value redraws the picker, so code reading or
 * writing the input does not need to know about the picker.
 */

type Mode = "single" | "multi" | "ordered";

interface Picker {
	input: HTMLInputElement;
	mode: Mode;
	codes: "code3" | "tag";
	variants: boolean;
	any: boolean;
	field: HTMLDivElement;
	search: HTMLInputElement;
}

interface Option {
	value: string;
	name: string;
	selected: boolean;
	custom?: boolean;
	divider?: boolean;
}

const SELECTOR = "input[data-language-picker]";
const ANY_NAME = "Everything else";
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;

let menu: HTMLDivElement | null = null;
let open: Picker | null = null;
let options: Option[] = [];
let active = 0;

const escapeHtml = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

function readTokens(picker: Picker): string[] {
	const raw = String(nativeValue.get!.call(picker.input) ?? "");
	if (picker.mode === "single") return raw.trim() ? [raw.trim()] : [];
	return raw
		.split(",")
		.map((token) => token.trim())
		.filter(Boolean);
}

function writeTokens(picker: Picker, tokens: string[]): void {
	nativeValue.set!.call(picker.input, picker.mode === "single" ? (tokens[0] ?? "") : tokens.join(", "));
	renderField(picker);
	picker.input.dispatchEvent(new Event("input", { bubbles: true }));
	picker.input.dispatchEvent(new Event("change", { bubbles: true }));
}

function valueOf(picker: Picker, entry: LanguageEntry): string {
	return picker.codes === "tag" ? entry.tag : entry.code3;
}

function sameLanguage(token: string, entry: LanguageEntry): boolean {
	return findLanguage(token) === entry;
}

function disabled(picker: Picker): boolean {
	return picker.input.matches(":disabled");
}

function chipHtml(picker: Picker, token: string, index: number): string {
	const entry = token === "*" ? null : findLanguage(token);
	const name = token === "*" ? ANY_NAME : (entry?.name ?? token);
	const unknown = token !== "*" && !entry;
	const remove =
		picker.mode === "single"
			? ""
			: `<button type="button" class="lang-chip-remove" data-lang-remove="${index}" aria-label="Remove ${escapeHtml(name)}">&times;</button>`;
	const order = picker.mode === "ordered" ? `<span class="lang-chip-order">${index + 1}</span>` : "";
	return `<span class="lang-chip${unknown ? " is-unknown" : ""}" data-lang-index="${index}"${picker.mode === "ordered" ? ' draggable="true"' : ""}${unknown ? ' title="Not a language this list knows. It is kept as typed."' : ""}>${order}<span class="lang-chip-name">${escapeHtml(name)}</span>${name === token ? "" : `<code>${escapeHtml(token)}</code>`}${remove}</span>`;
}

function renderField(picker: Picker): void {
	const tokens = readTokens(picker);
	for (const chip of picker.field.querySelectorAll(".lang-chip")) chip.remove();
	picker.search.insertAdjacentHTML("beforebegin", tokens.map((token, index) => chipHtml(picker, token, index)).join(""));
	const empty = picker.input.dataset.languageEmpty || "Search languages";
	picker.search.placeholder = tokens.length ? (picker.mode === "single" ? "Change" : "Add") : empty;
	if (open === picker) renderMenu();
}

function score(entry: LanguageEntry, query: string): number {
	const name = entry.name.toLowerCase();
	if (entry.aliases.includes(query)) return 0;
	if (name.startsWith(query)) return 1;
	if (entry.aliases.some((alias) => alias.startsWith(query))) return 2;
	if (name.split(/[\s(]+/).some((word) => word.startsWith(query))) return 3;
	if (name.includes(query)) return 4;
	return -1;
}

function buildOptions(picker: Picker): Option[] {
	const tokens = readTokens(picker);
	const query = picker.search.value.trim().toLowerCase();
	const held = tokens
		.map((token) => (token === "*" ? undefined : findLanguage(token)))
		.filter((entry): entry is LanguageEntry => !!entry && !isListedLanguage(entry));
	const entries = [...new Set([...held, ...LANGUAGES])].filter((entry) => picker.variants || !entry.variant);
	const toOption = (entry: LanguageEntry): Option => ({
		value: valueOf(picker, entry),
		name: entry.name,
		selected: tokens.some((token) => sameLanguage(token, entry)),
	});
	const out: Option[] = [];
	if (picker.any && (!query || "*".startsWith(query) || ANY_NAME.toLowerCase().includes(query))) {
		out.push({ value: "*", name: ANY_NAME, selected: tokens.includes("*") });
	}
	if (!query) {
		out.push(...entries.filter((entry) => entry.common || held.includes(entry)).map(toOption));
		const rest = entries.filter((entry) => !entry.common && !held.includes(entry)).map(toOption);
		if (rest[0]) rest[0].divider = true;
		out.push(...rest);
		return out;
	}
	const ranked = entries
		.map((entry, index) => ({ entry, index, score: score(entry, query) }))
		.filter((item) => item.score >= 0)
		.sort((a, b) => a.score - b.score || a.index - b.index);
	if (isLanguageCode(query) && !ranked.some((item) => item.score === 0)) {
		const typed = picker.search.value.trim();
		const variant = findLanguage(typed);
		if (variant && (picker.variants || !variant.variant)) out.push(toOption(variant));
		else out.push({ value: typed, name: `Use “${typed}”`, selected: tokens.includes(typed), custom: true });
	}
	out.push(...ranked.map((item) => toOption(item.entry)));
	return out;
}

function ensureMenu(): HTMLDivElement {
	if (menu) return menu;
	menu = document.createElement("div");
	menu.className = "lang-picker-menu";
	menu.setAttribute("role", "listbox");
	// Keeps focus in the search field, so picking does not blur and close the menu first.
	menu.addEventListener("mousedown", (event) => event.preventDefault());
	menu.addEventListener("click", (event) => {
		const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-lang-option]") : null;
		if (row && open) choose(open, Number(row.dataset.langOption));
	});
	return menu;
}

function renderMenu(): void {
	if (!open || !menu) return;
	options = buildOptions(open);
	active = Math.min(active, Math.max(0, options.length - 1));
	menu.innerHTML = options.length
		? options
				.map(
					(option, index) =>
						`<div class="lang-picker-option${index === active ? " is-active" : ""}${option.selected ? " is-selected" : ""}${option.divider ? " has-divider" : ""}" role="option" aria-selected="${option.selected}" data-lang-option="${index}"><span>${escapeHtml(option.name)}</span>${option.custom ? "" : `<code>${escapeHtml(option.value)}</code>`}</div>`,
				)
				.join("")
		: '<div class="lang-picker-empty">No language matches. Type a code such as ja or pt-BR to use it as it is.</div>';
	position();
}

function position(): void {
	if (!open || !menu) return;
	if (!open.field.isConnected) {
		closeMenu();
		return;
	}
	const rect = open.field.getBoundingClientRect();
	const below = window.innerHeight - rect.bottom;
	const height = Math.min(280, Math.max(below, rect.top) - 12);
	menu.style.left = `${rect.left}px`;
	menu.style.width = `${Math.max(rect.width, 240)}px`;
	menu.style.maxHeight = `${height}px`;
	if (below >= Math.min(280, rect.top)) {
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.bottom = "";
	} else {
		menu.style.top = "";
		menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
	}
}

function scrollActive(): void {
	menu?.querySelector(".lang-picker-option.is-active")?.scrollIntoView({ block: "nearest" });
}

function openMenu(picker: Picker): void {
	if (disabled(picker)) return;
	if (open !== picker) {
		open = picker;
		active = 0;
	}
	picker.field.classList.add("is-open");
	document.body.appendChild(ensureMenu());
	renderMenu();
	window.addEventListener("scroll", position, true);
	window.addEventListener("resize", position);
}

function closeMenu(): void {
	open?.field.classList.remove("is-open");
	if (open) open.search.value = "";
	open = null;
	menu?.remove();
	window.removeEventListener("scroll", position, true);
	window.removeEventListener("resize", position);
}

function choose(picker: Picker, index: number): void {
	const option = options[index];
	if (!option || disabled(picker)) return;
	const tokens = readTokens(picker);
	if (picker.mode === "single") {
		writeTokens(picker, [option.value]);
		closeMenu();
		picker.search.blur();
		return;
	}
	const entry = option.value === "*" || option.custom ? null : findLanguage(option.value);
	const existing = tokens.findIndex((token) => token === option.value || (!!entry && sameLanguage(token, entry)));
	if (existing >= 0) tokens.splice(existing, 1);
	else tokens.push(option.value);
	picker.search.value = "";
	active = Math.min(index, options.length - 1);
	writeTokens(picker, tokens);
	renderMenu();
}

function attach(input: HTMLInputElement): void {
	if (input.dataset.languagePickerReady) return;
	input.dataset.languagePickerReady = "1";
	const mode = (["single", "multi", "ordered"] as const).find((m) => m === input.dataset.languagePicker) ?? "multi";

	const field = document.createElement("div");
	field.className = `lang-picker lang-picker-${mode}`;
	const search = document.createElement("input");
	search.type = "text";
	search.className = "lang-picker-search";
	search.autocomplete = "off";
	search.spellcheck = false;
	search.setAttribute("aria-label", input.getAttribute("aria-label") || "Search languages");
	if (input.id) {
		search.id = `${input.id}-search`;
		for (const label of document.querySelectorAll<HTMLLabelElement>(`label[for="${CSS.escape(input.id)}"]`)) label.htmlFor = search.id;
	}
	field.appendChild(search);
	input.style.display = "none";
	input.after(field);

	const picker: Picker = {
		input,
		mode,
		codes: input.dataset.languageCodes === "tag" ? "tag" : "code3",
		variants: input.dataset.languageVariants !== "off",
		any: input.hasAttribute("data-language-any"),
		field,
		search,
	};

	Object.defineProperty(input, "value", {
		configurable: true,
		get: () => nativeValue.get!.call(input),
		set: (value: string) => {
			nativeValue.set!.call(input, value);
			renderField(picker);
		},
	});

	field.addEventListener("mousedown", (event) => {
		const target = event.target as Element;
		if (target === search || target.closest(".lang-chip-remove")) return;
		// Cancelling mousedown on a chip would also cancel dragging it.
		if (mode === "ordered" && target.closest(".lang-chip")) return;
		event.preventDefault();
		search.focus();
		openMenu(picker);
	});
	field.addEventListener("click", (event) => {
		const remove = (event.target as Element).closest<HTMLElement>("[data-lang-remove]");
		if (!remove || disabled(picker)) return;
		const tokens = readTokens(picker);
		tokens.splice(Number(remove.dataset.langRemove), 1);
		writeTokens(picker, tokens);
	});
	search.addEventListener("focus", () => openMenu(picker));
	search.addEventListener("blur", () => {
		if (open === picker) closeMenu();
	});
	search.addEventListener("input", (event) => {
		// The search text is not the value. Keep it away from handlers listening on the form.
		event.stopPropagation();
		active = 0;
		if (open !== picker) openMenu(picker);
		else renderMenu();
	});
	search.addEventListener("change", (event) => event.stopPropagation());
	search.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (open !== picker) return openMenu(picker);
			active = (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(1, options.length);
			renderMenu();
			scrollActive();
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (open === picker && options.length) choose(picker, active);
		} else if (event.key === "Escape") {
			if (open === picker) {
				event.stopPropagation();
				closeMenu();
			}
		} else if (event.key === "Backspace" && !search.value && picker.mode !== "single") {
			const tokens = readTokens(picker);
			if (tokens.length) writeTokens(picker, tokens.slice(0, -1));
		}
	});

	if (mode === "ordered") {
		let dragged = -1;
		field.addEventListener("dragstart", (event) => {
			const chip = (event.target as Element).closest<HTMLElement>(".lang-chip");
			if (!chip || disabled(picker)) return event.preventDefault();
			dragged = Number(chip.dataset.langIndex);
			event.dataTransfer?.setData("text/plain", String(dragged));
			chip.classList.add("is-dragging");
		});
		field.addEventListener("dragover", (event) => {
			if (dragged >= 0) event.preventDefault();
		});
		field.addEventListener("drop", (event) => {
			const chip = (event.target as Element).closest<HTMLElement>(".lang-chip");
			if (dragged < 0) return;
			event.preventDefault();
			const tokens = readTokens(picker);
			const [moved] = tokens.splice(dragged, 1);
			const to = chip ? Number(chip.dataset.langIndex) : tokens.length;
			tokens.splice(Math.min(to, tokens.length), 0, moved!);
			dragged = -1;
			writeTokens(picker, tokens);
		});
		field.addEventListener("dragend", () => {
			dragged = -1;
			field.querySelector(".is-dragging")?.classList.remove("is-dragging");
		});
	}

	renderField(picker);
}

function attachWithin(root: Element | Document): void {
	if (root instanceof HTMLInputElement && root.matches(SELECTOR)) attach(root);
	for (const input of root.querySelectorAll<HTMLInputElement>(SELECTOR)) attach(input);
}

/** Attach to every marked input now and to the ones rendered later. */
export function initLanguagePickers(): void {
	attachWithin(document);
	new MutationObserver((records) => {
		for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) attachWithin(node);
	}).observe(document.body, { childList: true, subtree: true });
}
