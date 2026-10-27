import { test } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChallenge, roomIdentity, verifyProof } from "./identity";

test("身份签名不暴露私钥，拒绝跨房间、跨连接与跨玩家重放，重启身份保持一致", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarp-identity-"));
  try {
    const player = { id: randomUUID(), nickname: "玩家" };
    const challenge = createChallenge(randomUUID());
    const proof = await roomIdentity(directory).prove(player, challenge, "channel-a");
    assert.deepEqual(Object.keys(proof).sort(), ["nonce", "player", "publicKey", "signature"]);
    const key = verifyProof(proof, challenge, "channel-a");
    assert.throws(() => verifyProof(proof, challenge, "channel-b"));
    assert.throws(() => verifyProof(proof, { ...challenge, roomId: randomUUID() }, "channel-a"));
    assert.throws(() => verifyProof(proof, createChallenge(challenge.roomId), "channel-a"));
    assert.throws(() =>
      verifyProof({ ...proof, player: { ...player, id: randomUUID() } }, challenge, "channel-a"),
    );
    const fresh = createChallenge(challenge.roomId);
    assert.equal(
      verifyProof(
        await roomIdentity(directory).prove(player, fresh, "new-channel"),
        fresh,
        "new-channel",
      ),
      key,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
