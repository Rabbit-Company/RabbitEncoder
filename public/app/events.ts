import type { JobSettings } from "../types";
import { initSubtitleEditor } from "../features/subtitle-editor";
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
import { closeJobModal, closeJobModalIfOutside, doRetry, openJobSettings, removeJob, removeJobs, saveJobSettings } from "../features/job-settings";
import { openFolderFromSearch, renderLibraryView } from "../features/library-search";
import {
	closeLibrary,
	closeLibraryIfOutside,
	handleLibraryEncode,
	handleLibraryTranslate,
	openLibrary,
	setLibraryFolderStats,
	toggleNodeCheck,
	toggleNodeExpand,
} from "../features/library";
import {
	chooseTranslateFolder,
	chooseTranslateVideo,
	closeTranslateSetup,
	closeTranslateSetupIfOutside,
	handleTranslateSourcesChange,
	openTranslateTool,
	submitTranslateSetup,
} from "../features/library-translate";
import {
	changeQueuePair,
	clearQueueOriginal,
	closeQueueSetup,
	closeQueueSetupIfOutside,
	pickQueueOriginalFile,
	pickQueueOriginalFolder,
	submitQueueSetup,
} from "../features/library-queue-setup";
import { handlePauseToggle, update } from "../features/polling";
import {
	closePreviewFullscreen,
	closePreviewFullscreenIfOutside,
	closePreviewModal,
	closePreviewModalIfOutside,
	cyclePreviewSampleView,
	downloadPreviewSampleArtifact,
	handlePreviewAddReference,
	handlePreviewCancel,
	handlePreviewClear,
	handlePreviewReferenceListClick,
	handlePreviewReferenceListInput,
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
import { openSeriesNotesModal, closeSeriesNotesModal, closeSeriesNotesModalIfOutside } from "../features/series-notes-modal";
import { initNavMenus } from "../features/nav-menus";
import {
	addCompareSource,
	cancelCompareRun,
	closeCompare,
	closeCompareIfOutside,
	clearRecentCompares,
	compareNextFrame,
	comparePrevFrame,
	deleteCurrentCompare,
	downloadAllCompare,
	handleCompareKey,
	handleCompareModeChange,
	handleCompareSourcesClick,
	handleCompareSourcesInput,
	handleCompareTabsClick,
	newCompare,
	openCompare,
	openRecentCompare,
	startCompareRun,
} from "../features/compare";
import { closeAbout, closeAboutIfOutside, copyVersions, openAbout } from "../features/about";
import {
	chooseHdrFolder,
	chooseHdrTarget,
	closeHdrTool,
	closeHdrToolIfOutside,
	handleHdrActionsChange,
	handleHdrActionsClick,
	handleHdrUpload,
	openHdrTool,
	queueHdrChanges,
} from "../features/hdr-tool";
import {
	applySubtitleSearch,
	chooseSubtitleSearchVideo,
	closeSubtitleSearch,
	closeSubtitleSearchIfOutside,
	handleSubtitleSearchResultsChange,
	handleSubtitleSearchResultsClick,
	openSubtitleSearch,
	runSubtitleSearch,
} from "../features/subtitle-search";
import {
	chooseSubtitleOcrFolder,
	chooseSubtitleOcrTarget,
	closeSubtitleOcr,
	closeSubtitleOcrIfOutside,
	handleSubtitleOcrTracksChange,
	openSubtitleOcr,
	queueSubtitleOcr,
} from "../features/subtitle-ocr";
import {
	chooseGrainFolder,
	chooseGrainTarget,
	closeGrainTool,
	closeGrainToolIfOutside,
	handleGrainActionsChange,
	handleGrainClick,
	handleGrainUpload,
	openGrainTool,
	queueGrainChanges,
} from "../features/grain-tool";
import { closeSubStyleModal, closeSubStyleModalIfOutside, openSubStyleModal, saveCurrentGroupStyle } from "../features/sub-style-modal";
import {
	closeRepair,
	closeRepairIfOutside,
	closeRepairPicker,
	closeRepairPickerIfOutside,
	chooseRepairPickerFile,
	clearRepairSource,
	filterRepairPicker,
	handleRepairEditorInput,
	handleRepairPickerClick,
	handleRepairTrackMove,
	inspectRepairPaths,
	openRepair,
	openRepairPicker,
	queueRepair,
	replaceSubtitlesFromSource,
} from "../features/repair";
import {
	closeRepairBatch,
	closeRepairBatchIfOutside,
	handleRepairBatchPairChange,
	openRepairBatch,
	pairRepairBatchFolders,
	pickRepairBatchSourceFolder,
	pickRepairBatchTargetFolder,
	queueRepairBatch,
} from "../features/repair-batch";
import {
	closeRepairAudit,
	closeRepairAuditIfOutside,
	handleRepairAuditClick,
	handleRepairAuditInput,
	openRepairAuditJobs,
	openRepairAuditPicker,
	openSelectedAuditRepair,
} from "../features/repair-audit";

export function getCurrentSettings(): JobSettings | null {
	if (appState.currentAdvancedTarget === "default") return window._tempDefaults ?? null;
	if (appState.currentAdvancedTarget === "job") return window._tempJobSettings ?? null;
	return null;
}

export function initEventListeners() {
	initNavMenus();
	initSubtitleEditor();
	byId("open-repair-audit-btn").addEventListener("click", openRepairAuditPicker);
	byId("close-repair-audit-btn").addEventListener("click", closeRepairAudit);
	byId("repair-audit-close-btn").addEventListener("click", closeRepairAudit);
	byId("repair-audit-modal").addEventListener("click", closeRepairAuditIfOutside);
	byId("repair-audit-pick-folder-btn").addEventListener("click", openRepairAuditPicker);
	byId("repair-audit-files").addEventListener("click", handleRepairAuditClick);
	byId("repair-audit-groups").addEventListener("click", handleRepairAuditClick);
	byId("repair-audit-details").addEventListener("click", handleRepairAuditClick);
	byId("repair-audit-details").addEventListener("input", handleRepairAuditInput);
	byId("repair-audit-open-btn").addEventListener("click", openSelectedAuditRepair);
	byId("open-repair-btn").addEventListener("click", () => openRepair());
	byId("close-repair-btn").addEventListener("click", closeRepair);
	byId("repair-cancel-btn").addEventListener("click", closeRepair);
	byId("repair-modal").addEventListener("click", closeRepairIfOutside);
	byId("repair-inspect-btn").addEventListener("click", () => inspectRepairPaths());
	byId("repair-queue-btn").addEventListener("click", queueRepair);
	byId("repair-replace-btn").addEventListener("click", replaceSubtitlesFromSource);
	byId("open-repair-batch-btn").addEventListener("click", openRepairBatch);
	byId("close-repair-batch-btn").addEventListener("click", closeRepairBatch);
	byId("repair-batch-cancel-btn").addEventListener("click", closeRepairBatch);
	byId("repair-batch-modal").addEventListener("click", closeRepairBatchIfOutside);
	byId("repair-batch-pick-target-btn").addEventListener("click", pickRepairBatchTargetFolder);
	byId("repair-batch-pick-source-btn").addEventListener("click", pickRepairBatchSourceFolder);
	byId("repair-batch-pair-btn").addEventListener("click", pairRepairBatchFolders);
	byId("repair-batch-pairs").addEventListener("change", handleRepairBatchPairChange);
	byId("repair-batch-queue-btn").addEventListener("click", queueRepairBatch);
	byId("repair-pick-target-btn").addEventListener("click", () => openRepairPicker("target"));
	byId("repair-pick-source-btn").addEventListener("click", () => openRepairPicker("source"));
	byId("repair-clear-source-btn").addEventListener("click", clearRepairSource);
	byId("close-repair-picker-btn").addEventListener("click", closeRepairPicker);
	byId("repair-picker-modal").addEventListener("click", closeRepairPickerIfOutside);
	byId("repair-picker-content").addEventListener("click", handleRepairPickerClick);
	byId("repair-picker-search").addEventListener("input", filterRepairPicker);
	byId("repair-picker-choose-btn").addEventListener("click", chooseRepairPickerFile);
	byId("repair-tracks").addEventListener("input", handleRepairEditorInput);
	byId("repair-tracks").addEventListener("change", handleRepairEditorInput);
	byId("repair-tracks").addEventListener("click", handleRepairTrackMove);
	byId("repair-source-tracks").addEventListener("click", handleRepairTrackMove);

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

	byId("default-open-series-notes-btn").addEventListener("click", () => void openSeriesNotesModal());
	byId("job-open-series-notes-btn").addEventListener("click", () => void openSeriesNotesModal());
	byId("close-series-notes-modal-btn").addEventListener("click", closeSeriesNotesModal);
	byId("close-series-notes-done-btn").addEventListener("click", closeSeriesNotesModal);
	byId("series-notes-modal").addEventListener("click", closeSeriesNotesModalIfOutside);

	byId("open-about-btn").addEventListener("click", () => void openAbout());
	byId("about-close").addEventListener("click", closeAbout);
	byId("about-done").addEventListener("click", closeAbout);
	byId("about-modal").addEventListener("click", closeAboutIfOutside);
	byId("about-copy").addEventListener("click", () => void copyVersions());
	byId("open-hdr-btn").addEventListener("click", openHdrTool);
	byId("hdr-close").addEventListener("click", closeHdrTool);
	byId("hdr-cancel").addEventListener("click", closeHdrTool);
	byId("hdr-modal").addEventListener("click", closeHdrToolIfOutside);
	byId("hdr-choose-target").addEventListener("click", chooseHdrTarget);
	byId("hdr-choose-folder").addEventListener("click", chooseHdrFolder);
	byId("hdr-actions").addEventListener("change", handleHdrActionsChange);
	byId("hdr-actions").addEventListener("input", handleHdrActionsChange);
	byId("hdr-actions").addEventListener("click", handleHdrActionsClick);
	byId("hdr-upload-input").addEventListener("change", () => void handleHdrUpload());
	byId("hdr-queue").addEventListener("click", () => void queueHdrChanges());

	byId("open-subocr-btn").addEventListener("click", openSubtitleOcr);
	byId("subocr-close").addEventListener("click", closeSubtitleOcr);
	byId("subocr-cancel").addEventListener("click", closeSubtitleOcr);
	byId("subocr-modal").addEventListener("click", closeSubtitleOcrIfOutside);
	byId("subocr-choose-target").addEventListener("click", chooseSubtitleOcrTarget);
	byId("subocr-choose-folder").addEventListener("click", chooseSubtitleOcrFolder);
	byId("subocr-tracks").addEventListener("change", handleSubtitleOcrTracksChange);
	byId("subocr-queue").addEventListener("click", () => void queueSubtitleOcr());

	byId("open-subsearch-btn").addEventListener("click", openSubtitleSearch);
	byId("subsearch-close").addEventListener("click", closeSubtitleSearch);
	byId("subsearch-cancel").addEventListener("click", closeSubtitleSearch);
	byId("subsearch-modal").addEventListener("click", closeSubtitleSearchIfOutside);
	byId("subsearch-choose").addEventListener("click", chooseSubtitleSearchVideo);
	byId("subsearch-search").addEventListener("click", () => void runSubtitleSearch());
	byId("subsearch-results").addEventListener("click", handleSubtitleSearchResultsClick);
	byId("subsearch-results").addEventListener("change", handleSubtitleSearchResultsChange);
	byId("subsearch-apply").addEventListener("click", () => void applySubtitleSearch("mux"));
	byId("subsearch-sidecar").addEventListener("click", () => void applySubtitleSearch("sidecar"));

	byId("open-grain-btn").addEventListener("click", openGrainTool);
	byId("grain-close").addEventListener("click", closeGrainTool);
	byId("grain-cancel").addEventListener("click", closeGrainTool);
	byId("grain-modal").addEventListener("click", closeGrainToolIfOutside);
	byId("grain-choose-target").addEventListener("click", chooseGrainTarget);
	byId("grain-choose-folder").addEventListener("click", chooseGrainFolder);
	byId("grain-actions").addEventListener("change", handleGrainActionsChange);
	byId("grain-actions").addEventListener("input", handleGrainActionsChange);
	byId("grain-actions").addEventListener("click", handleGrainClick);
	byId("grain-inspection").addEventListener("click", handleGrainClick);
	byId("grain-upload-input").addEventListener("change", () => void handleGrainUpload());
	byId("grain-queue").addEventListener("click", () => void queueGrainChanges());

	byId("open-compare-btn").addEventListener("click", openCompare);
	byId("compare-close").addEventListener("click", closeCompare);
	byId("compare-modal").addEventListener("click", closeCompareIfOutside);
	byId("compare-add").addEventListener("click", addCompareSource);
	byId("compare-sources").addEventListener("input", handleCompareSourcesInput);
	byId("compare-sources").addEventListener("change", handleCompareSourcesInput);
	byId("compare-sources").addEventListener("click", handleCompareSourcesClick);
	byId("compare-mode").addEventListener("change", handleCompareModeChange);
	byId("compare-recent").addEventListener("change", () => void openRecentCompare());
	byId("compare-clear").addEventListener("click", () => void clearRecentCompares());
	byId("compare-delete").addEventListener("click", () => void deleteCurrentCompare());
	byId("compare-start").addEventListener("click", () => void startCompareRun());
	byId("compare-cancel").addEventListener("click", () => void cancelCompareRun());
	byId("compare-new").addEventListener("click", newCompare);
	byId("compare-tabs").addEventListener("click", handleCompareTabsClick);
	byId("compare-prev").addEventListener("click", comparePrevFrame);
	byId("compare-next").addEventListener("click", compareNextFrame);
	byId("compare-download-all").addEventListener("click", () => void downloadAllCompare());
	document.addEventListener("keydown", handleCompareKey);

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
	byId("preview-add-reference-btn").addEventListener("click", handlePreviewAddReference);
	byId("preview-reference-list").addEventListener("click", handlePreviewReferenceListClick);
	byId("preview-reference-list").addEventListener("input", handlePreviewReferenceListInput);
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
		const auditFolderButton = target.closest<HTMLElement>(".btn-folder-audit");
		if (auditFolderButton) {
			e.stopPropagation();
			const jobIds = (auditFolderButton.dataset.auditJobIds || "").split(",").filter(Boolean);
			if (jobIds.length) void openRepairAuditJobs(jobIds, auditFolderButton.dataset.auditFolderLabel);
			return;
		}
		const dismissFolderButton = target.closest<HTMLElement>(".btn-folder-dismiss");
		if (dismissFolderButton) {
			e.stopPropagation();
			const jobIds = (dismissFolderButton.dataset.dismissJobIds || "").split(",").filter(Boolean);
			if (jobIds.length) void removeJobs(jobIds);
			return;
		}
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
			repair: openRepair,
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
	inputById("library-folder-stats").addEventListener("change", (event) => setLibraryFolderStats((event.target as HTMLInputElement).checked));
	byId("close-library-btn").addEventListener("click", closeLibrary);
	byId("close-subtitle-preview-btn").addEventListener("click", closeSubPreview);
	byId("library-modal").addEventListener("click", closeLibraryIfOutside);
	byId("library-encode-btn").addEventListener("click", handleLibraryEncode);
	byId("library-translate-btn").addEventListener("click", handleLibraryTranslate);
	byId("library-translate-close").addEventListener("click", closeTranslateSetup);
	byId("library-translate-cancel").addEventListener("click", closeTranslateSetup);
	byId("library-translate-modal").addEventListener("click", closeTranslateSetupIfOutside);
	byId("library-translate-submit").addEventListener("click", submitTranslateSetup);
	byId("library-translate-download").addEventListener("change", handleTranslateSourcesChange);
	byId("library-translate-ai-fallback").addEventListener("change", handleTranslateSourcesChange);
	byId("open-subtranslate-btn").addEventListener("click", openTranslateTool);
	byId("library-translate-pick-file").addEventListener("click", chooseTranslateVideo);
	byId("library-translate-pick-folder").addEventListener("click", chooseTranslateFolder);
	byId("library-queue-close").addEventListener("click", closeQueueSetup);
	byId("library-queue-cancel").addEventListener("click", closeQueueSetup);
	byId("library-queue-modal").addEventListener("click", closeQueueSetupIfOutside);
	byId("library-queue-file").addEventListener("click", pickQueueOriginalFile);
	byId("library-queue-folder").addEventListener("click", pickQueueOriginalFolder);
	byId("library-queue-clear").addEventListener("click", clearQueueOriginal);
	byId("library-queue-pairs").addEventListener("change", changeQueuePair);
	byId("library-queue-submit").addEventListener("click", submitQueueSetup);

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
