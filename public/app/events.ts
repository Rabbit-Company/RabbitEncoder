import type { JobSettings } from "../types";
import type { PreviewArtifactKind, PreviewSampleCard } from "../ui/models";
import { cancelJob, handleLogin, logout, reloadVsPresets } from "../api/client";
import {
	closeAudioPreview,
	closeAudioPreviewIfOutside,
	closeMediaInfo,
	closeSubPreview,
	closeSubPreviewIfOutside,
	openAudioPreview,
	openMediaInfo,
	openSubtitlePreview,
} from "../features/job-render";
import {
	closeBitrateAnalysis,
	closeBitrateAnalysisIfOutside,
	handleBitrateDownload,
	handleBitrateRefresh,
	handleBitrateSaveThresholds,
	openBitrateAnalysis,
	openBitrateAnalysisImport,
} from "../features/bitrate-analysis";
import { closeJobModal, closeJobModalIfOutside, doRetry, openJobSettings, removeJob, saveJobSettings } from "../features/job-settings";
import { openFolderFromSearch, renderLibraryView } from "../features/library-search";
import { closeLibrary, closeLibraryIfOutside, handleLibraryEncode, openLibrary, toggleNodeCheck, toggleNodeExpand } from "../features/library";
import { handlePauseToggle, update } from "../features/polling";
import {
	closePreviewFullscreen,
	closePreviewFullscreenIfOutside,
	closePreviewModal,
	closePreviewModalIfOutside,
	cyclePreviewSampleView,
	downloadPreviewSampleArtifact,
	handlePreviewCancel,
	handlePreviewClear,
	handlePreviewRun,
	initPreviewOptionControls,
	openPreviewFullscreen,
	openPreviewModal,
	togglePreviewSampleView,
} from "../features/preview";
import { handleMove } from "../features/queue-order";
import {
	closeAdvancedModal,
	closeAdvancedModalIfOutside,
	closeSettings,
	closeSettingsIfOutside,
	onResetDefaultsClick,
	openAdvancedModal,
	openSettings,
	saveSettings,
} from "../features/settings-modal";
import { closeBenchmark, closeBenchmarkIfOutside, handleBenchmarkCancel, handleBenchmarkRun, openBenchmark } from "../features/system-benchmark";
import { renderVsChainEditor } from "../features/vapoursynth";
import { asElementTarget, byId, inputById } from "../shared/dom";
import { appState } from "../state";
import { delegateClick } from "../ui/delegate";
import { dispatchJobAction } from "../ui/job-actions";
import { openFontGroupsModal, closeFontGroupsModal, closeFontGroupsModalIfOutside } from "../features/font-groups-modal";
import { closeSubStyleModal, closeSubStyleModalIfOutside, openSubStyleModal, saveCurrentGroupStyle } from "../features/sub-style-modal";

export function getCurrentSettings(): JobSettings | null {
	if (appState.currentAdvancedTarget === "default") return window._tempDefaults ?? null;
	if (appState.currentAdvancedTarget === "job") return window._tempJobSettings ?? null;
	return null;
}

export function initEventListeners() {
	byId("open-settings-btn").addEventListener("click", openSettings);
	byId("close-settings-btn").addEventListener("click", closeSettings);
	byId("save-settings-btn").addEventListener("click", saveSettings);
	byId("reset-settings-btn").addEventListener("click", onResetDefaultsClick);

	byId("settings-modal").addEventListener("click", closeSettingsIfOutside);

	byId("close-job-modal-btn").addEventListener("click", closeJobModal);
	byId("job-modal").addEventListener("click", closeJobModalIfOutside);
	byId("save-job-settings-btn").addEventListener("click", saveJobSettings);

	byId("open-default-advanced-btn").addEventListener("click", () => openAdvancedModal("default"));
	byId("open-job-advanced-btn").addEventListener("click", () => openAdvancedModal("job"));
	byId("close-advanced-modal-btn").addEventListener("click", closeAdvancedModal);
	byId("close-advanced-done-btn").addEventListener("click", closeAdvancedModal);
	byId("advanced-modal").addEventListener("click", closeAdvancedModalIfOutside);

	byId("save-sub-style-btn").addEventListener("click", saveCurrentGroupStyle);
	byId("default-open-sub-style-btn").addEventListener("click", () => openSubStyleModal("default"));
	byId("job-open-sub-style-btn").addEventListener("click", () => openSubStyleModal("job"));
	byId("close-sub-style-modal-btn").addEventListener("click", closeSubStyleModal);
	byId("close-sub-style-done-btn").addEventListener("click", closeSubStyleModal);
	byId("sub-style-modal").addEventListener("click", closeSubStyleModalIfOutside);

	byId("default-open-font-groups-btn").addEventListener("click", openFontGroupsModal);
	byId("job-open-font-groups-btn").addEventListener("click", openFontGroupsModal);
	byId("close-font-groups-modal-btn").addEventListener("click", closeFontGroupsModal);
	byId("close-font-groups-done-btn").addEventListener("click", closeFontGroupsModal);
	byId("font-groups-modal").addEventListener("click", closeFontGroupsModalIfOutside);

	byId("vs-reload-btn").onclick = async () => {
		await reloadVsPresets();
		const settings = getCurrentSettings();
		if (settings) renderVsChainEditor(byId("advanced-vs-chain"), settings);
	};

	byId("sub-preview-modal").addEventListener("click", closeSubPreviewIfOutside);
	byId("logout-btn").addEventListener("click", logout);

	byId("close-audio-preview-btn").addEventListener("click", closeAudioPreview);
	byId("audio-preview-modal").addEventListener("click", closeAudioPreviewIfOutside);

	byId("pause-queue-btn").addEventListener("click", handlePauseToggle);

	byId("open-benchmark-btn").addEventListener("click", openBenchmark);
	byId("close-benchmark-btn").addEventListener("click", closeBenchmark);
	byId("benchmark-modal").addEventListener("click", closeBenchmarkIfOutside);
	byId("benchmark-run-btn").addEventListener("click", handleBenchmarkRun);
	byId("benchmark-cancel-btn").addEventListener("click", handleBenchmarkCancel);

	byId("close-preview-modal-btn").addEventListener("click", closePreviewModal);
	byId("preview-modal").addEventListener("click", closePreviewModalIfOutside);
	byId("preview-run-btn").addEventListener("click", handlePreviewRun);
	byId("preview-cancel-btn").addEventListener("click", handlePreviewCancel);
	byId("preview-clear-btn").addEventListener("click", handlePreviewClear);
	initPreviewOptionControls();

	byId("login-submit-btn").addEventListener("click", handleLogin);
	byId("login-password").addEventListener("keydown", (e) => {
		if (e.key === "Enter") handleLogin();
	});

	const librarySearchEl = inputById("library-search");
	librarySearchEl.addEventListener("input", () => {
		appState.librarySearchQuery = librarySearchEl.value;
		byId("library-search-clear").style.display = librarySearchEl.value ? "" : "none";
		renderLibraryView();
	});
	const librarySearchClearEl = byId("library-search-clear");
	if (librarySearchClearEl)
		librarySearchClearEl.addEventListener("click", () => {
			const input = inputById("library-search");
			input.value = "";
			appState.librarySearchQuery = "";
			librarySearchClearEl.style.display = "none";
			renderLibraryView();
			input.focus();
		});

	byId("jobs-list").addEventListener("click", (e) => {
		const target = asElementTarget(e.target);
		if (!target) return;
		const moveBtn = target.closest<HTMLElement>(".btn-move");
		if (moveBtn) {
			e.stopPropagation();
			const direction = moveBtn.dataset.action === "move-up" ? "up" : "down";
			const moveContainer = moveBtn.closest<HTMLElement>(".move-buttons")!;
			const moveType = moveContainer.dataset.moveType;

			if (moveType === "folder") {
				const movePath = moveContainer.dataset.movePath;
				if (movePath) handleMove(movePath, direction, false, null);
			} else if (moveType === "file") {
				const jobId = moveContainer.dataset.moveJob;
				const folderJob = moveBtn.closest<HTMLElement>(".folder-job");
				const containingFolder = folderJob?.dataset.containingFolder ?? "";
				if (jobId) handleMove(containingFolder, direction, true, jobId);
			}
			return;
		}

		const folderHeader = target.closest<HTMLElement>(".folder-header");
		if (folderHeader) {
			const path = folderHeader.dataset.folderPath;
			if (!path) return;
			if (appState.expandedFolders.has(path)) {
				appState.expandedFolders.delete(path);
			} else {
				appState.expandedFolders.add(path);
			}
			appState.lastJobsJson = "";
			update();
			return;
		}

		const button = target.closest<HTMLButtonElement>(".btn-icon");
		if (!button) return;

		dispatchJobAction(button.dataset.action, button.dataset.id, {
			edit: openJobSettings,
			remove: removeJob,
			dismiss: removeJob,
			retry: doRetry,
			cancel: async (id) => {
				await cancelJob(id);
				await update();
			},
			preview: openPreviewModal,
			"sub-preview": openSubtitlePreview,
			"audio-preview": openAudioPreview,
			mediainfo: openMediaInfo,
			bitrate: openBitrateAnalysis,
		});
	});

	delegateClick<PreviewSampleCard>(byId("preview-samples"), ".preview-sample", (e, card) => {
		const rawTarget = e.target;
		if (!(rawTarget instanceof Element)) return;

		const dlBtn = rawTarget.closest<HTMLElement>("[data-dl]");
		if (dlBtn) {
			e.stopPropagation();
			const sampleIdx = parseInt(card.dataset.idx!, 10);
			if (appState.currentPreviewJobId && dlBtn.dataset.dl && Number.isFinite(sampleIdx))
				downloadPreviewSampleArtifact(appState.currentPreviewJobId, sampleIdx, dlBtn.dataset.dl as PreviewArtifactKind);
			return;
		}

		const fullscreenBtn = rawTarget.closest('[data-action="fullscreen"]');
		if (fullscreenBtn) {
			e.stopPropagation();
			openPreviewFullscreen(card);
			return;
		}

		const toggleHost = rawTarget.closest('[data-action="toggle"]');
		if (toggleHost) togglePreviewSampleView(card);
	});

	byId("close-preview-fullscreen-btn").addEventListener("click", closePreviewFullscreen);
	byId("preview-fullscreen-modal").addEventListener("click", closePreviewFullscreenIfOutside);
	byId("preview-fullscreen-stage").addEventListener("click", () => {
		if (appState.currentPreviewFullscreenCard) togglePreviewSampleView(appState.currentPreviewFullscreenCard);
	});

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			closePreviewFullscreen();
			return;
		}

		// Arrow / Space navigation only fires when fullscreen preview is open.
		if (!appState.currentPreviewFullscreenCard) return;

		// Don't hijack typing in inputs.
		const t = e.target instanceof HTMLElement ? e.target : null;
		if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

		if (e.key === "ArrowRight" || e.code === "Space") {
			e.preventDefault();
			cyclePreviewSampleView(appState.currentPreviewFullscreenCard, +1);
		} else if (e.key === "ArrowLeft") {
			e.preventDefault();
			cyclePreviewSampleView(appState.currentPreviewFullscreenCard, -1);
		}
	});

	byId("open-library-btn").addEventListener("click", openLibrary);
	byId("close-library-btn").addEventListener("click", closeLibrary);
	byId("close-subtitle-preview-btn").addEventListener("click", closeSubPreview);
	byId("library-modal").addEventListener("click", closeLibraryIfOutside);
	byId("library-encode-btn").addEventListener("click", handleLibraryEncode);

	byId("library-content").addEventListener("click", (e) => {
		const target = asElementTarget(e.target);
		if (!target) return;
		const chevron = target.closest<HTMLElement>('[data-action="expand"]');
		if (chevron) {
			const path = chevron.dataset.path;
			if (path) toggleNodeExpand(path);
			return;
		}

		const checkbox = target.closest<HTMLElement>('[data-action="check"]');
		if (checkbox) {
			const path = checkbox.dataset.path;
			if (path) toggleNodeCheck(path);
			return;
		}

		const open = target.closest<HTMLElement>('[data-action="search-open"]');
		if (open) {
			const path = open.dataset.path;
			if (path) openFolderFromSearch(path);
			return;
		}
	});

	byId("close-mediainfo-btn").addEventListener("click", closeMediaInfo);
	byId("mediainfo-modal").addEventListener("click", (e) => {
		if (e.target === e.currentTarget) closeMediaInfo();
	});
	byId("copy-mediainfo-btn").addEventListener("click", () => {
		navigator.clipboard.writeText(byId("mediainfo-content").textContent ?? "");
		closeMediaInfo();
	});

	byId("close-bitrate-modal-btn").addEventListener("click", closeBitrateAnalysis);
	byId("close-bitrate-done-btn").addEventListener("click", closeBitrateAnalysis);
	byId("bitrate-modal").addEventListener("click", closeBitrateAnalysisIfOutside);
	byId("bitrate-save-btn").addEventListener("click", handleBitrateSaveThresholds);
	byId("bitrate-download-btn").addEventListener("click", handleBitrateDownload);
	byId("bitrate-refresh-btn").addEventListener("click", handleBitrateRefresh);

	const bitrateImportInput = byId<HTMLInputElement>("bitrate-import-input");
	byId("import-bitrate-analysis-btn").addEventListener("click", () => bitrateImportInput.click());
	bitrateImportInput.addEventListener("change", () => {
		const file = bitrateImportInput.files?.[0];
		bitrateImportInput.value = "";
		if (file) openBitrateAnalysisImport(file);
	});
}
