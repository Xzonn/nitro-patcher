import { createCipheriv, createHash, createHmac, createPublicKey, verify } from "node:crypto";
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
export const verifyRsaSha1 = (data: Uint8Array, signature: Uint8Array): boolean => {
  const key = createPublicKey({
    key: {
      kty: "RSA",
      n: Buffer.from(
        "956F790DF08BB85A76AAEFA27FE874758BED9EDF9E9A670CD818BEB9B2885203B3FA11AEAA186513B5D6BB85A384D0D0EFB366CBC6051AAA86827AB74311F59C9BFC6C7079D5F17BD0819F522056738C721F40CF2361932590A3C5DC94CFD17A8CBC954A918AA858F4D804BAF7D3C1C4D7B8F077012FA170260B2C049056F3A5",
        "hex",
      ).toString("base64url"),
      e: "AQAB",
    },
    format: "jwk",
  });
  return verify("RSA-SHA1", data, key, signature);
};
