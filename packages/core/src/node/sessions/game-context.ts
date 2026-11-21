import type { SessionDatabase } from "../storage/session-database";
import { storedTypes, readCharacters } from "./character-db";
import { listGameFileRecords } from "./game-file-index";
import { mapPositionPrompt } from "./map-description";

/** 仅提供本局资料入口；状态结构与玩法含义由模组规则解释。 */
export async function gameStatePrompt(db: SessionDatabase): Promise<string> {
  const worldTypes = new Set(
    storedTypes(db)
      .filter((type) => type.designation === "world_state")
      .map((type) => type.id),
  );
  const worlds = listGameFileRecords(db)
    .filter((file) => worldTypes.has(file.typeId))
    .map((file) => file.path);
  const characters = readCharacters(db)
    .filter((character) => character.playerId && !character.retired && character.sourcePath)
    .map((character) => ({
      id: character.id,
      path: character.sourcePath,
      playerId: character.playerId,
    }));
  const map = mapPositionPrompt(db);
  return `本局资料入口（幕后索引，不向玩家公开路径）：${JSON.stringify({ worlds, characters })}。位置、场景、时间、回合、效果与结局均按模组字段和规则解释；不得由开局背景或旧聊天推定当前值。${map ? `\n${map}` : ""}`;
}
