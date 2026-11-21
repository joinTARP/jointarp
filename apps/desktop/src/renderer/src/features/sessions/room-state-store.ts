import { Decoder } from "@colyseus/schema";
import {
  roomStateFrameSchema,
  chatActivitySchema,
  type RoomBaseline,
  type RoomEntity,
  type RoomEntityOverlay,
  type RoomReplica,
  type RoomSections,
  type RoomStateFrame,
} from "@jointarp/core/shared/room-state";
import { applyRoomEntityOverlay } from "@jointarp/core/shared/room-state-overlay";
import { RoomStateSchema, stableJson } from "@jointarp/core/shared/room-state-schema";

/** Decoder 保存累计覆盖；只有合并模组基线并校验成功后才发布当前视图。 */
export class RoomStateStore {
  private decoder?: Decoder<InstanceType<typeof RoomStateSchema>>;
  private streamId?: string;
  private seq = 0;
  private snapshot?: RoomReplica;
  private sectionJson = new Map<string, string>();
  private owners = new WeakMap<object, string>();
  private overlays = new Map<
    string,
    { header: string; overlay: RoomEntityOverlay; fields: Map<string, string> }
  >();
  private changedIds: string[] = [];
  getChangedEntityIds = () => this.changedIds;
  constructor(private baseline: RoomBaseline) {}

  getSnapshot = () => this.snapshot;
  resetBaseline() {
    this.decoder = undefined;
    this.streamId = undefined;
    this.seq = 0;
  }
  apply(raw: RoomStateFrame): boolean {
    const frame = roomStateFrameSchema.parse(raw);
    if (frame.baselineVersion !== this.baseline.version)
      throw Object.assign(new Error("本地冻结模组基线版本与状态帧不匹配，请恢复相同版本后重试"), {
        code: "BASELINE_MISMATCH",
      });
    if (this.streamId === frame.streamId && frame.seq <= this.seq) return false;
    if (
      frame.kind === "patch" &&
      (!this.decoder ||
        frame.streamId !== this.streamId ||
        frame.baseSeq !== this.seq ||
        frame.seq !== this.seq + 1)
    )
      throw new Error("房间增量不连续，需要重新同步");
    if (frame.kind === "snapshot" && this.streamId && frame.streamId !== this.streamId)
      throw new Error("房间同步流已变化，需要重新建立基线");
    try {
      const decoder =
        frame.kind === "snapshot" ? new Decoder(new RoomStateSchema()) : this.decoder!;
      const binary = atob(frame.payload);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const iterator = { offset: 0 };
      decoder.triggerChanges = () => {};
      const changes = decoder.decode(bytes, iterator);
      const dirty = new Set<string>();
      if (frame.kind === "snapshot") {
        for (const id of this.overlays.keys()) dirty.add(id);
        for (const [id, encoded] of decoder.state.entities) {
          dirty.add(id);
          this.owners.set(encoded, id);
          this.owners.set(encoded.fields, id);
        }
      } else {
        // 新 collection 项先建立 owner，后续字段变化可直接定位实体。
        for (const change of changes) {
          if (change.ref === decoder.state.entities && typeof change.dynamicIndex === "string") {
            const id = change.dynamicIndex;
            dirty.add(id);
            const encoded = decoder.state.entities.get(id);
            if (encoded) {
              this.owners.set(encoded, id);
              this.owners.set(encoded.fields, id);
            }
          }
        }
        for (const change of changes) {
          const id = this.owners.get(change.ref);
          if (id) dirty.add(id);
        }
      }
      if (iterator.offset !== bytes.length) throw new Error("房间状态帧不完整");
      const sections = {} as RoomSections;
      const sectionJson = new Map<string, string>();
      for (const key of [
        "viewerId",
        "room",
        "launch",
        "metrics",
        "chatActivity",
        "companionVersion",
        "map",
      ] as const) {
        const json = decoder.state.sections.get(key);
        if (json === undefined) throw new Error("房间状态缺少必要字段");
        Object.defineProperty(sections, key, {
          enumerable: true,
          value:
            json === this.sectionJson.get(key)
              ? this.snapshot?.sections[key]
              : key === "chatActivity"
                ? chatActivitySchema.parse(JSON.parse(json))
                : JSON.parse(json),
        });
        sectionJson.set(key, json);
      }
      let entities = this.snapshot?.entities ?? this.baseline.entities;
      let mutable: Record<string, RoomEntity> | undefined;
      const overlays = dirty.size ? new Map(this.overlays) : this.overlays;
      const changedIds: string[] = [];
      for (const id of dirty) {
        const encoded = decoder.state.entities.get(id);
        let entity: RoomEntity | undefined;
        if (!encoded) {
          overlays.delete(id);
          entity = this.baseline.entities[id];
        } else {
          const cached = this.overlays.get(id);
          const fieldJson = new Map<string, string>();
          const fields: Record<string, unknown> = {};
          for (const [key, json] of encoded.fields) {
            fieldJson.set(key, json);
            fields[key] =
              cached?.fields.get(key) === json ? cached.overlay.fields[key] : JSON.parse(json);
          }
          const header = encoded.header;
          const overlay = {
            ...(cached?.header === header ? cached.overlay : JSON.parse(header)),
            fields,
          } as RoomEntityOverlay;
          overlays.set(id, { header, overlay, fields: fieldJson });
          entity = overlay.deleted
            ? undefined
            : applyRoomEntityOverlay(id, this.baseline.entities[id], overlay);
          const previous = this.snapshot?.entities[id];
          if (entity && previous) {
            let values: Readonly<Record<string, unknown>> = Object.fromEntries(
              Object.entries(entity.document.values).map(([key, value]) => [
                key,
                stableJson(value) === stableJson(previous.document.values[key])
                  ? previous.document.values[key]
                  : value,
              ]),
            );
            if (
              Object.keys(values).length === Object.keys(previous.document.values).length &&
              Object.keys(values).every((key) => values[key] === previous.document.values[key])
            )
              values = previous.document.values;
            const document = { ...entity.document, values };
            entity = {
              ...entity,
              ...(entity.character
                ? {
                    character:
                      stableJson(entity.character) === stableJson(previous.character)
                        ? previous.character
                        : entity.character,
                  }
                : {}),
              document:
                stableJson(document) === stableJson(previous.document)
                  ? previous.document
                  : document,
            };
            if (
              entity.id === previous.id &&
              entity.revision === previous.revision &&
              entity.character === previous.character &&
              entity.document === previous.document
            )
              entity = previous;
          }
        }
        if (entity === entities[id]) continue;
        mutable ??= Object.assign(Object.create(null), entities);
        if (entity) mutable![id] = entity;
        else delete mutable![id];
        changedIds.push(id);
      }
      entities = mutable ?? entities;
      const documentRevision = JSON.parse(decoder.state.sections.get("documentRevision") ?? "null");
      if (!Number.isSafeInteger(documentRevision) || documentRevision < 0)
        throw new Error("房间文档版本无效");
      this.decoder = decoder;
      this.streamId = frame.streamId;
      this.seq = frame.seq;
      this.sectionJson = sectionJson;
      this.overlays = overlays;
      this.changedIds = changedIds;
      this.snapshot = {
        sections,
        entities,
        documentRevision,
      };
      return true;
    } catch (error) {
      this.resetBaseline();
      throw error;
    }
  }
}
