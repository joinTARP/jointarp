import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { join } from "node:path";

import { structuredFile } from "@jointarp/core/node/storage/structured-file";
import { playerSchema, type Player } from "@jointarp/core/shared/game";
import { z } from "zod";

export const challengeSchema = z.object({
  roomId: z.string().uuid(),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
});
export type IdentityChallenge = z.infer<typeof challengeSchema>;
export const proofSchema = z.object({
  player: playerSchema,
  publicKey: z.string().min(1).max(128),
  signature: z.string().min(1).max(128),
  nonce: challengeSchema.shape.nonce,
});
export type IdentityProof = z.infer<typeof proofSchema>;
export const createChallenge = (roomId: string): IdentityChallenge => ({
  roomId,
  nonce: randomBytes(32).toString("hex"),
});
function message(player: Player, challenge: IdentityChallenge, binding: string) {
  return Buffer.from(
    JSON.stringify(["tarp-room-auth", 1, player.id, challenge.roomId, challenge.nonce, binding]),
  );
}
export function verifyProof(input: IdentityProof, challenge: IdentityChallenge, binding: string) {
  if (input.nonce !== challenge.nonce) throw Error("身份挑战不匹配");
  try {
    const key = createPublicKey({
      key: Buffer.from(input.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        message(input.player, challenge, binding),
        key,
        Buffer.from(input.signature, "base64"),
      )
    )
      throw Error("invalid proof");
    return createHash("sha256")
      .update(key.export({ format: "der", type: "spki" }))
      .digest("hex");
  } catch {
    throw Error("玩家身份签名无效");
  }
}
export function roomIdentity(directory: string) {
  const store = structuredFile(join(directory, "room-identity.json"), {
    validate: z.object({ privateKey: z.string().max(4096) }).parse,
    missing: () => ({
      privateKey: generateKeyPairSync("ed25519")
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
    }),
    fileMode: 0o600,
  });
  return {
    async prove(
      player: Player,
      challenge: IdentityChallenge,
      binding: string,
    ): Promise<IdentityProof> {
      const identity = await store.update((value) => value);
      const key = createPrivateKey(identity.privateKey);
      if (key.asymmetricKeyType !== "ed25519") throw Error("本机联机身份密钥无效");
      return {
        player,
        nonce: challenge.nonce,
        publicKey: createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64"),
        signature: sign(null, message(player, challenge, binding), key).toString("base64"),
      };
    },
  };
}
