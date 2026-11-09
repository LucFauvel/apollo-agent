/**
 * Reads the target machine of a Windows PE file (.exe, .dll, .node) from its COFF header, so a
 * Windows build can prove apollo.exe and the tailnet addon are really for the arch it claims.
 */
export const PE_MACHINES: Record<number, string> = { 0x8664: "x64", 0xaa64: "arm64", 0x014c: "ia32" };

/** "x64" | "arm64" | "ia32", or null when `bytes` is not a PE image (or a machine we don't know). */
export const peMachine = (bytes: Uint8Array): string | null => {
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null; // "MZ"
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(0x3c, true);
  if (pe + 6 > bytes.length) return null;
  if (view.getUint32(pe, true) !== 0x00004550) return null; // "PE\0\0"
  return PE_MACHINES[view.getUint16(pe + 4, true)] ?? null;
};
