/** Envelope-like noise with a fixed seed, so a test is repeatable. */
export function envelope(length: number, seed = 1): Float32Array {
	let x = seed >>> 0;
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		x = (x + 0x6d2b79f5) >>> 0;
		let t = Math.imul(x ^ (x >>> 15), x | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
