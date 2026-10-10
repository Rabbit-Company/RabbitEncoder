import type { AutoDenoiseMetric, DenoiseBackend } from "../types";
import type { AdvancedTarget, SettingsCodePanelElement } from "../ui/models";
import {
	decodeSettingsCodeRequest,
	fetchAvdDevices,
	fetchConfig,
	fetchOpenClDevices,
	fetchVulkanDevices,
	patchConfig,
	resetConfigRequest,
} from "../api/client";
import { getCurrentSettings } from "../app/events";
import {
	AUTO_DENOISE_METRICS,
	DEFAULT_AUTO_THRESHOLDS,
	DEFAULT_BITRATE_THRESHOLDS,
	DEFAULT_GRADFUN_PARAMS,
	DEFAULT_NLMEANS_PARAMS,
	DEFAULT_AVD_PARAMS,
	AVD_PRESETS,
	AVD_STRENGTH_HELP,
	DENOISE_BACKENDS,
	DEFAULT_DENOISE_ENGINE,
} from "../config/options";
import {
	mountSettingsCodePanel,
	renderAutoThresholds,
	renderGpuDevicePicker,
	renderGradfunParamsEditor,
	renderNlmeansParamsEditor,
	renderRadioPills,
} from "./settings-controls";
import { cloneSettingsForEditing, renderSettingsForm, updateDenoiseLevelHint } from "./settings-form";
import { renderVsChainEditor } from "./vapoursynth";
import { byId } from "../shared/dom";
import { appState } from "../state";

export { applyPresetToSettings, inferPreset } from "./settings-form";

export async function openSettings() {
	if (!appState.defaults) appState.defaults = await fetchConfig();

	const base = window._tempDefaults ?? appState.defaults;
	const tempDefaults = cloneSettingsForEditing(base);
	window._tempDefaults = tempDefaults;

	renderSettingsForm("default", tempDefaults);

	mountSettingsCodePanel(byId("settings-code-panel-default"), {
		getSettings: () => window._tempDefaults,
		onImport: (code) => decodeSettingsCodeRequest(code),
		onApplied: (settings) => {
			if (window._tempDefaults) Object.assign(window._tempDefaults, settings);
			openSettings();
		},
	});

	byId("settings-modal").style.display = "";
}

export async function saveSettings() {
	if (!window._tempDefaults) return;
	appState.defaults = await patchConfig(window._tempDefaults);
	closeSettings();
}

export async function onResetDefaultsClick() {
	if (!confirm("Reset all settings to appState.defaults? This will discard your customizations.")) return;
	const res = await resetConfigRequest();
	appState.defaults = res;
	closeSettings();
}

export function closeSettings() {
	window._tempDefaults = null;
	const panel = byId<SettingsCodePanelElement>("settings-code-panel-default");
	if (panel._codeTimer) {
		clearInterval(panel._codeTimer);
		panel._codeTimer = null;
	}
	byId("settings-modal").style.display = "none";
}

export function closeSettingsIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeSettings();
}

/** Single number input for a self-tuning engine's scale, styled like one row of the per-level editors. */
function renderScaleInput(container: HTMLElement, value: number, onChange: (value: number) => void): void {
	container.innerHTML = "";
	const wrap = document.createElement("div");
	wrap.className = "auto-threshold-grid";
	const row = document.createElement("label");
	row.className = "auto-threshold-row";
	const span = document.createElement("span");
	span.textContent = "scale";
	const input = document.createElement("input");
	input.type = "number";
	input.step = "0.05";
	input.min = "0.1";
	input.max = "10";
	input.value = String(value);
	input.onchange = () => {
		const n = parseFloat(input.value);
		const v = Number.isFinite(n) ? Math.min(10, Math.max(0.1, n)) : 1;
		input.value = String(v);
		onChange(v);
	};
	row.appendChild(span);
	row.appendChild(input);
	wrap.appendChild(row);
	container.appendChild(wrap);
}

export async function openAdvancedModal(target: AdvancedTarget): Promise<void> {
	appState.currentAdvancedTarget = target;
	const settings = target === "default" ? window._tempDefaults : window._tempJobSettings;
	if (!settings) return;
	const activeSettings = settings;

	if (!settings.nlmeansParams) {
		settings.nlmeansParams = JSON.parse(JSON.stringify(DEFAULT_NLMEANS_PARAMS));
	}
	if (!settings.gradfunParams) {
		settings.gradfunParams = JSON.parse(JSON.stringify(DEFAULT_GRADFUN_PARAMS));
	}
	if (!settings.autoDenoiseThresholds) {
		settings.autoDenoiseThresholds = { ...DEFAULT_AUTO_THRESHOLDS };
	}
	if (!settings.autoDenoiseBitrateThresholds) {
		settings.autoDenoiseBitrateThresholds = { ...DEFAULT_BITRATE_THRESHOLDS };
	}
	if (!settings.autoDenoiseMetric) settings.autoDenoiseMetric = "noise";
	if (!settings.denoiseBackend) settings.denoiseBackend = "auto";
	if (!settings.denoiseEngine) settings.denoiseEngine = DEFAULT_DENOISE_ENGINE;
	if (!settings.avdParams) settings.avdParams = JSON.parse(JSON.stringify(DEFAULT_AVD_PARAMS));
	if (!settings.avdDevice) settings.avdDevice = "default";
	if (settings.gpuDevice === undefined || settings.gpuDevice === null) {
		settings.gpuDevice = settings.denoiseBackend === "vulkan" ? "0" : "0.0";
	}

	const titleEl = byId("advanced-modal-title");
	titleEl.textContent = target === "default" ? "Advanced Default Settings" : "Advanced Job Settings";

	const backendEl = byId("advanced-denoise-backend");
	const deviceGroupEl = byId("advanced-gpu-device-group");
	const devicePickerEl = byId("advanced-gpu-device");

	async function refreshDevicePicker(backend: DenoiseBackend): Promise<void> {
		if (backend === "cpu") {
			deviceGroupEl.style.display = "none";
			return;
		}
		deviceGroupEl.style.display = "";
		const devices = backend === "vulkan" ? await fetchVulkanDevices() : await fetchOpenClDevices();
		// "auto" probes vulkan first; show vulkan devices for that case.
		renderGpuDevicePicker(devicePickerEl, devices, activeSettings.gpuDevice, (v) => (activeSettings.gpuDevice = v));
	}

	renderRadioPills(backendEl, DENOISE_BACKENDS, settings.denoiseBackend, async (v) => {
		const prev = settings.denoiseBackend;
		settings.denoiseBackend = v;
		// Reset gpuDevice format only when crossing the vulkan/opencl divide.
		if (v === "vulkan" && prev !== "vulkan") settings.gpuDevice = "0";
		else if (v === "opencl" && prev !== "opencl") settings.gpuDevice = "0.0";
		else if (v === "auto" && (prev === "cpu" || !settings.gpuDevice)) settings.gpuDevice = "0";
		await refreshDevicePicker(v);
	});
	await refreshDevicePicker(settings.denoiseBackend);

	// The denoiser itself is picked in the main settings. Here every denoiser's settings are editable,
	// with the selected one's card marked.
	const isAvd = settings.denoiseEngine !== "nlmeans";
	byId("advanced-nlmeans-in-use").style.display = isAvd ? "none" : "";
	byId("advanced-avd-in-use").style.display = isAvd ? "" : "none";

	renderRadioPills(byId("advanced-avd-preset"), AVD_PRESETS, settings.avdParams.preset, (v) => (activeSettings.avdParams.preset = v));

	const avdDeviceIds = (await fetchAvdDevices()).map((d) => d.id);
	const avdDeviceEl = byId("advanced-avd-device");
	const avdDeviceHelp = byId("advanced-avd-device-help");
	if (avdDeviceIds.length === 0) {
		avdDeviceEl.innerHTML = "";
		avdDeviceHelp.textContent = "av-denoise found no usable GPU. It has no CPU fallback, so jobs using these denoisers will fail.";
	} else {
		if (!avdDeviceIds.includes(settings.avdDevice)) settings.avdDevice = avdDeviceIds[0]!;
		renderRadioPills(avdDeviceEl, avdDeviceIds, settings.avdDevice, (v) => (activeSettings.avdDevice = v));
		avdDeviceHelp.textContent = "default lets av-denoise pick. There is no CPU fallback: the job fails if the device cannot be used.";
	}

	// Plain NLMeans needs its strength set by hand for each level.
	byId("advanced-avd-strengths-help-avd-nlmeans").textContent = AVD_STRENGTH_HELP["avd-nlmeans"];
	renderAutoThresholds(byId("advanced-avd-strengths-avd-nlmeans"), settings.avdParams.nlmeansStrength, (v) => (activeSettings.avdParams.nlmeansStrength = v), {
		min: 0.1,
		max: 10,
		step: 0.05,
	});

	// The other two set their own strength per scene, so they take one scale for every level.
	for (const engine of ["avd-nlmeans-hq", "avd-nl4d"] as const) {
		byId(`advanced-avd-strengths-help-${engine}`).textContent = AVD_STRENGTH_HELP[engine];
		renderScaleInput(byId(`advanced-avd-strengths-${engine}`), settings.avdParams.scales[engine], (v) => (activeSettings.avdParams.scales[engine] = v));
	}

	const cep = byId<HTMLTextAreaElement>("advanced-custom-encoder-params");
	const s = getCurrentSettings();
	if (s) {
		cep.value = s.customEncoderParams || "";
		cep.oninput = () => {
			s.customEncoderParams = cep.value;
		};
	}

	const METRIC_HELP: Record<AutoDenoiseMetric, string> = {
		noise: "Classifies scenes by peak bit-plane noise reading (0-1). Good for classic sensor/film grain.",
		bitrate:
			'Classifies scenes by their own bitrate as a multiple of the file\'s median. Targets "this costs a lot of bits" directly, regardless of why. This is better for structured VFX texture that reads as only moderately noisy but is still expensive to encode.',
	};
	const METRIC_BOUNDS: Record<AutoDenoiseMetric, { min: number; max: number; step: number }> = {
		noise: { min: 0, max: 1, step: 0.01 },
		bitrate: { min: 0, max: 20, step: 0.1 },
	};

	function renderThresholdsForMetric(): void {
		const metric = settings!.autoDenoiseMetric;
		byId("advanced-auto-denoise-metric-help").textContent = METRIC_HELP[metric];
		byId("advanced-auto-thresholds-label").textContent = metric === "bitrate" ? "Auto Denoise Thresholds (x median bitrate)" : "Auto Denoise Thresholds (0-1)";
		byId("advanced-auto-thresholds-hint").textContent =
			metric === "bitrate"
				? "A scene whose bitrate reaches a multiple of the file's median gets that level. Scenes below light are not denoised."
				: "A scene whose peak noise reading reaches a value gets that level. Scenes below light are not denoised.";
		const thresholds = metric === "bitrate" ? settings!.autoDenoiseBitrateThresholds : settings!.autoDenoiseThresholds;
		renderAutoThresholds(
			byId("advanced-auto-thresholds"),
			thresholds,
			(v) => {
				if (metric === "bitrate") settings!.autoDenoiseBitrateThresholds = v;
				else settings!.autoDenoiseThresholds = v;
			},
			METRIC_BOUNDS[metric],
		);
	}

	renderRadioPills(byId("advanced-auto-denoise-metric"), AUTO_DENOISE_METRICS, settings.autoDenoiseMetric, (v) => {
		settings!.autoDenoiseMetric = v;
		renderThresholdsForMetric();
	});
	renderThresholdsForMetric();

	renderNlmeansParamsEditor(byId("advanced-nlmeans-params"), settings.nlmeansParams, (v) => (settings.nlmeansParams = v));

	renderGradfunParamsEditor(byId("advanced-gradfun-params"), settings.gradfunParams, (v) => (settings.gradfunParams = v));

	renderVsChainEditor(byId("advanced-vs-chain"), settings);

	byId("advanced-modal").style.display = "";
}

export function closeAdvancedModal() {
	byId("advanced-modal").style.display = "none";
	// The engine or its expert scales may have changed, which decides whether the levels differ.
	const target = appState.currentAdvancedTarget;
	const edited = target === "default" ? window._tempDefaults : window._tempJobSettings;
	if (target && edited) updateDenoiseLevelHint(target, edited);
	appState.currentAdvancedTarget = null;
}

export function closeAdvancedModalIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeAdvancedModal();
}
