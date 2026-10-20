/** Header dropdowns: one open at a time, closed by an outside click, Escape, or picking an item. */

function menus(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>("[data-nav-menu]")];
}

function parts(menu: HTMLElement): { toggle: HTMLButtonElement; list: HTMLElement; items: HTMLButtonElement[] } {
	const list = menu.querySelector<HTMLElement>(".nav-menu-list")!;
	return {
		toggle: menu.querySelector<HTMLButtonElement>(".nav-menu-toggle")!,
		list,
		items: [...list.querySelectorAll<HTMLButtonElement>(".nav-menu-item")].filter((item) => item.style.display !== "none" && !item.disabled),
	};
}

function setOpen(menu: HTMLElement, open: boolean): void {
	const { toggle, list } = parts(menu);
	list.hidden = !open;
	toggle.setAttribute("aria-expanded", String(open));
	menu.classList.toggle("open", open);
}

function closeAll(except?: HTMLElement): void {
	for (const menu of menus()) if (menu !== except && menu.classList.contains("open")) setOpen(menu, false);
}

export function initNavMenus(): void {
	for (const menu of menus()) {
		const { toggle, list } = parts(menu);
		toggle.addEventListener("click", () => {
			const open = !menu.classList.contains("open");
			closeAll(menu);
			setOpen(menu, open);
		});
		toggle.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowDown") return;
			event.preventDefault();
			closeAll(menu);
			setOpen(menu, true);
			parts(menu).items[0]?.focus();
		});
		// Item handlers are registered elsewhere. Closing here runs after them.
		list.addEventListener("click", (event) => {
			if (event.target instanceof Element && event.target.closest(".nav-menu-item")) setOpen(menu, false);
		});
		list.addEventListener("keydown", (event) => {
			const { items } = parts(menu);
			const at = items.indexOf(document.activeElement as HTMLButtonElement);
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const next = (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
				items[next]?.focus();
			} else if (event.key === "Home" || event.key === "End") {
				event.preventDefault();
				items[event.key === "Home" ? 0 : items.length - 1]?.focus();
			}
		});
	}

	document.addEventListener("click", (event) => {
		if (!(event.target instanceof Element) || !event.target.closest("[data-nav-menu]")) closeAll();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		const open = menus().find((menu) => menu.classList.contains("open"));
		if (!open) return;
		setOpen(open, false);
		parts(open).toggle.focus();
	});
}
