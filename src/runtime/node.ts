import { createCipheriv, createHash, createHmac } from "node:crypto";
export { verifyDsiSignature as verifyRsaSha1 } from "./rsa";
export { readFile, writeFile } from "node:fs/promises";
export { readFileSync } from "node:fs";
export { inflateRawSync } from "node:zlib";

export const hashDigest = (algorithm: "md5" | "sha1", data: Uint8Array): Buffer =>
  createHash(algorithm).update(data).digest();
export const hmacSha1 = (key: Uint8Array, data: Uint8Array): Buffer => createHmac("sha1", key).update(data).digest();
export const createAesBlockCipher = (key: Uint8Array): ((block: Uint8Array) => Buffer) => {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return (block) => cipher.update(block);
};
