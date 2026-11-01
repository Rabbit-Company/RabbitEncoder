import { writeFileSync } from "fs";
import { join } from "path";
import { run } from "../core/process";

/**
 * SSIMULACRA2 of chosen frames of a source and its encode, with vszip. The
 * frames are read as runs of a constant step, one per scene, so ffms2 decodes
 * forward instead of seeking for every frame. With "dark", each frame is also
 * scored with the luma of both lifted by a square root, which brings errors
 * near black up to where they show on a bright screen or in a dark room.
 */
const SCORE_PY = String.raw`
import json, sys
import vapoursynth as vs
core = vs.core
a = json.load(open(sys.argv[1]))
frames = a["frames"]

def matrix_tagged(clip):
    if clip.format.color_family == vs.YUV and clip.get_frame(0).props.get("_Matrix", 2) == 2:
        clip = core.std.SetFrameProps(clip, _Matrix=1 if clip.height >= 720 else 6)
    return clip

ref = matrix_tagged(core.ffms2.Source(a["ref"], cachefile=a["refIndex"]))
dis = matrix_tagged(core.ffms2.Source(a["dist"], cachefile=a["distIndex"]))
fmt = core.query_video_format(vs.YUV, vs.INTEGER, 10, ref.format.subsampling_w, ref.format.subsampling_h)
ref = core.resize.Spline36(ref, format=fmt.id)
dis = core.resize.Spline36(dis, width=ref.width, height=ref.height, format=fmt.id)

runs = []
for f in frames:
    if runs and (len(runs[-1]) == 1 or f - runs[-1][-1] == runs[-1][1] - runs[-1][0]):
        runs[-1].append(f)
    else:
        runs.append([f])
def picked(clip):
    parts = [clip[r[0]] if len(r) == 1 else clip[r[0] : r[-1] + 1 : r[1] - r[0]] for r in runs]
    return core.std.Splice(parts) if len(parts) > 1 else parts[0]
ref, dis = picked(ref), picked(dis)

clips = [core.vszip.SSIMULACRA2(ref, dis)]
if a["dark"]:
    full = ref.get_frame(0).props.get("_ColorRange", 1) == 0
    lo, span = (0, 1023) if full else (64, 876)
    lift = f"x {lo} - {span} / 0 max 1 min sqrt {span} * {lo} +"
    lifted = lambda c: core.std.Expr(c, [lift, "", ""])
    clips.append(core.vszip.SSIMULACRA2(lifted(ref), lifted(dis)))

print(json.dumps({"total": len(frames)}), flush=True)
for n, fs in enumerate(zip(*[c.frames() for c in clips])):
    out = {"n": n, "s": round(fs[0].props["SSIMULACRA2"], 4)}
    if len(fs) > 1:
        out["d"] = round(fs[1].props["SSIMULACRA2"], 4)
    print(json.dumps(out), flush=True)
`;

export interface ScoreOptions {
	reference: string;
	encode: string;
	/** Frame numbers to score, ascending. */
	frames: number[];
	/** Also score with the luma lifted, and keep the lower of the two. */
	dark: boolean;
	workDir: string;
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
}

/** One score per frame asked for, in the same order. */
export async function scoreFrames(o: ScoreOptions): Promise<number[]> {
	const argsFile = join(o.workDir, "score_args.json");
	writeFileSync(
		argsFile,
		JSON.stringify({
			ref: o.reference,
			dist: o.encode,
			refIndex: join(o.workDir, "reference.ffindex"),
			distIndex: join(o.workDir, "fast.ffindex"),
			frames: o.frames,
			dark: o.dark,
		}),
	);
	const scores = new Array<number>(o.frames.length);
	let received = 0;
	const res = await run(["python3", "-c", SCORE_PY, argsFile], {
		signal: o.signal,
		onStdoutLine: (raw) => {
			if (!raw.startsWith("{")) return;
			try {
				const line = JSON.parse(raw) as { n?: number; s?: number; d?: number };
				if (line.n === undefined || line.s === undefined) return;
				scores[line.n] = line.d === undefined ? line.s : Math.min(line.s, line.d);
				received++;
				o.onProgress?.(received, o.frames.length);
			} catch {}
		},
	});
	if (o.signal?.aborted) throw new Error("Scoring cancelled");
	if (res.code !== 0) throw new Error(`Scoring the fast pass failed: ${(res.stderr || res.stdout).trim().slice(-500)}`);
	if (received !== o.frames.length) throw new Error(`Scoring the fast pass returned ${received} of ${o.frames.length} frames`);
	return scores;
}
