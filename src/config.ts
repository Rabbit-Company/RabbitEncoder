import type { AppConfig, AudioChannelBitrates, EncoderQuality, EncoderSpeed } from "./types";

const DEFAULT_BITRATES: AudioChannelBitrates = {
	mono: 64,
	stereo: 128,
	"2.1": 160,
	"5.1": 256,
	"6.1": 320,
	"7.1": 384,
	"7.1.4": 512,
};

export function loadConfig(): AppConfig {
	const quality = (process.env.ENCODER_QUALITY || "medium") as EncoderQuality;
	const finalSpeed = (process.env.ENCODER_SPEED || "slow") as EncoderSpeed;

	const bitrates: AudioChannelBitrates = {
		mono: parseInt(process.env.AUDIO_BITRATE_MONO || "") || DEFAULT_BITRATES.mono,
		stereo: parseInt(process.env.AUDIO_BITRATE_STEREO || "") || DEFAULT_BITRATES.stereo,
		"2.1": parseInt(process.env.AUDIO_BITRATE_2_1 || "") || DEFAULT_BITRATES["2.1"],
		"5.1": parseInt(process.env.AUDIO_BITRATE_5_1 || "") || DEFAULT_BITRATES["5.1"],
		"6.1": parseInt(process.env.AUDIO_BITRATE_6_1 || "") || DEFAULT_BITRATES["6.1"],
		"7.1": parseInt(process.env.AUDIO_BITRATE_7_1 || "") || DEFAULT_BITRATES["7.1"],
		"7.1.4": parseInt(process.env.AUDIO_BITRATE_7_1_4 || "") || DEFAULT_BITRATES["7.1.4"],
	};

	return {
		inputDir: process.env.INPUT_DIR || "/data/input",
		outputDir: process.env.OUTPUT_DIR || "/data/output",
		tempDir: process.env.TEMP_DIR || "/data/temp",
		port: parseInt(process.env.PORT || "3000"),
		organization: process.env.ORGANIZATION || "RabbitCompany",
		contact: process.env.CONTACT || "https://rabbit-company.com",
		defaults: {
			quality,
			finalSpeed,
			audioBitrates: bitrates,
		},
	};
}
