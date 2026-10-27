import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { playAudio, SpeechPlayer } from "./speech-player";
import { playStream } from "./stream-player";

export const speechPlayer = new SpeechPlayer({
  synthesize: (text, speaker, preview, signal) =>
    desktopRpc.tts.synthesize({ text, speaker, preview }, { signal }),
  play: playAudio,
  streamPlay: (text, speaker, preview, signal, onPlaying) =>
    playStream(
      () => desktopRpc.tts.stream({ text, speaker, preview }, { signal }),
      signal,
      onPlaying,
    ),
});
export function useSpeechSnapshot() {
  return useSyncExternalStore(
    speechPlayer.subscribe,
    speechPlayer.getSnapshot,
    speechPlayer.getSnapshot,
  );
}
export function useSpeech(owner: string) {
  const roomOptions = desktopOrpc.tts.roomSettings.queryOptions({ input: { roomId: owner } });
  const lan = useQuery(desktopOrpc.lan.status.queryOptions({ input: { roomId: owner } }));
  const room = useQuery({ ...roomOptions, enabled: lan.data?.remote === false });
  const client = useQueryClient();
  const automatic = useMutation({
    ...desktopOrpc.tts.automatic.mutationOptions(),
    onSuccess(value) {
      if (!value.automatic) speechPlayer.stop(owner);
      client.setQueryData(roomOptions.queryKey, value);
    },
  });
  useEffect(() => () => speechPlayer.stop(owner), [owner]);
  const available = room.data?.enabled === true && room.data.hasKey === true;
  return { settings: room, room, automatic, available };
}
