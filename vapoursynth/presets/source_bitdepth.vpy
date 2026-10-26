"""Convert the source to a selected integer bit depth before other filters.

Rabbit Encoder provides SRC for each job. This pass does not trim frames or
change the frame rate. Rabbit Encoder muxes audio and subtitles from the
original source.
"""

import vapoursynth as vs

import rabbit_vs


target_bits = rabbit_vs.arg_int("target_bits", 10)
convert_higher = rabbit_vs.arg_bool("convert_higher", False)

if target_bits not in (8, 10, 12, 16):
	raise ValueError("Target bit depth must be 8, 10, 12, or 16")

src = rabbit_vs.load_source(rabbit_vs.arg_str("SRC"))
if src.format is None or src.format.sample_type != vs.INTEGER:
	raise ValueError("Source bit depth conversion requires a constant integer pixel format")

source_bits = src.format.bits_per_sample
if source_bits < target_bits or (convert_higher and source_bits > target_bits):
	rabbit_vs.check_plugin("fmtc", "install the fmtc VapourSynth plugin")
	# Ordered dithering retains smooth gradients when reducing precision. Upscaling
	# only needs rounding and cannot create detail absent from the source.
	out = vs.core.fmtc.bitdepth(src, bits=target_bits, dmode=0 if source_bits > target_bits else 1)
else:
	out = src

out.set_output(0)
