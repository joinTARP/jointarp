function attr(value: string) {
  return value.replaceAll('"', "'").replaceAll("\n", " ");
}

export interface PlayerTurn {
  text: string;
  playerId: string;
  characterName?: string;
  /** 主持专用的移动意图说明，在生成主持输入时按当时的地图状态计算。 */
  movement?: string;
}

/** 一条玩家发言。多人时按顺序拼成多块，正文保持原样。 */
function playerTurnMessage(input: PlayerTurn) {
  const character = input.characterName ? ` character="${attr(input.characterName)}"` : "";
  const movement = input.movement ? `\n<movement>${input.movement}</movement>` : "";
  return `<message${character} playerId="${attr(input.playerId)}">\n${input.text}${movement}\n</message>`;
}

export function playerTurnPrompt(turns: readonly PlayerTurn[]) {
  return turns.map(playerTurnMessage).join("\n");
}
