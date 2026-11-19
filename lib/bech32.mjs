// Minimal bech32 (BIP-173) re-encoding: turn a validator operator address
// (qorvaloper1...) into its account address (qor1...). Same 20 bytes.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const expand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

export function decode(address) {
  const s = address.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1) throw new Error("not bech32");
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error("bad bech32 character");
    return i;
  });
  if (polymod([...expand(hrp), ...data]) !== 1) throw new Error("bad bech32 checksum");
  return { hrp, words: data.slice(0, -6) };
}

export function encode(hrp, words) {
  const mod = polymod([...expand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((i) => CHARSET[i]).join("")}`;
}

export const toAccount = (address, hrp = "qor") => encode(hrp, decode(address).words);
