import forge from "node-forge";

import { hashDigest } from "#nitro-runtime";

const publicKey = forge.pki.rsa.setPublicKey(
  new forge.jsbn.BigInteger(
    "956F790DF08BB85A76AAEFA27FE874758BED9EDF9E9A670CD818BEB9B2885203B3FA11AEAA186513B5D6BB85A384D0D0EFB366CBC6051AAA86827AB74311F59C9BFC6C7079D5F17BD0819F522056738C721F40CF2361932590A3C5DC94CFD17A8CBC954A918AA858F4D804BAF7D3C1C4D7B8F077012FA170260B2C049056F3A5",
    16,
  ),
  new forge.jsbn.BigInteger("10001", 16),
);

export const verifyDsiSignature = (data: Uint8Array, signature: Uint8Array): boolean =>
  publicKey.verify(hashDigest("sha1", data).toString("latin1"), Buffer.from(signature).toString("latin1"), "NONE");
