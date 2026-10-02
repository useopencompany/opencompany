import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateEncrypt } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

const mobileRequire = createRequire(new URL("../../apps/mobile/package.json", import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
const cliRequire = createRequire(expoRequire.resolve("@expo/cli"));
const forge = cliRequire("node-forge");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 3,
});
const verifier = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }));
const digest = forge.md.sha256.create().update("Expo signature regression").digest().getBytes();

function signDigestInfo(includeNull, includeGarbage) {
  const { asn1 } = forge;
  const algorithm = [
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.OID,
      false,
      asn1.oidToDer(forge.pki.oids.sha256).getBytes(),
    ),
  ];
  if (includeNull) {
    algorithm.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""));
  }
  if (includeGarbage) {
    algorithm.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, "garbage"));
  }
  const info = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, algorithm),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
  ]);
  const encoded = Buffer.from(asn1.toDer(info).getBytes(), "binary");
  const block = Buffer.concat([
    Buffer.from([0, 1]),
    Buffer.alloc(256 - encoded.length - 3, 0xff),
    Buffer.from([0]),
    encoded,
  ]);
  return privateEncrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, block).toString(
    "binary",
  );
}

test("patched node-forge rejects extra nested DigestAlgorithm elements", () => {
  assert.throws(
    () => verifier.verify(digest, signDigestInfo(true, true)),
    /does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo/,
  );
});

test("patched node-forge accepts valid SHA-256 signatures with optional NULL", () => {
  assert.equal(verifier.verify(digest, signDigestInfo(true, false)), true);
  assert.equal(verifier.verify(digest, signDigestInfo(false, false)), true);
});
