import pkg from "../package.json";
import { showLogin } from "./api/client";
import { initEventListeners } from "./app/events";
import { API } from "./config/api-base";
import { fetchLibraryDirs } from "./features/library";
import { startPolling } from "./features/polling";
import { byId } from "./shared/dom";
import { initLanguagePickers } from "./shared/language-picker";
import { appState } from "./state";

byId("title-version").innerText = `v${pkg.version}`;

export async function init() {
	initEventListeners();
	initLanguagePickers();

	if (!appState.authToken) {
		showLogin("");
		return;
	}

	try {
		const res = await fetch(`${API}/api/config`, {
			headers: { Authorization: `Bearer ${appState.authToken}` },
		});

		if (res.status === 401 || res.status === 403) {
			appState.authToken = "";
			localStorage.removeItem("authToken");
			showLogin("");
			return;
		}

		appState.defaults = await res.json();
		startPolling();

		try {
			const libData = await fetchLibraryDirs();
			if (libData.length > 0) {
				byId("open-library-btn").style.display = "";
			}
		} catch {}
	} catch {
		showLogin("Cannot reach server");
	}
}

document.addEventListener("DOMContentLoaded", init);
