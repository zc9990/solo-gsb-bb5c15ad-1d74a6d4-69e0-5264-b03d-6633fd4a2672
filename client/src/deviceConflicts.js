// 设备占用冲突推演（客户端镜像，语义与 server/src/devices.js 的 computeDeviceConflicts 一致）
//
// 服务端在每一帧权威快照后下发设备配置与权威冲突列表；客户端仅在两份快照之间对
// “超时（finished）”外推的预计起止区间做本地平滑重算（与 time.js 的 liveAgenda 同口径），
// 权威结果永远以服务端下一帧消息为准。固定环节与跨午夜比较直接使用推演行原始毫秒值。

// 由设备清单与（可能已本地外推的）议程推演行计算冲突，输出按最早冲突排序。
export function computeDeviceConflicts(devices, projectedRows) {
  const rowById = new Map();
  (projectedRows ?? []).forEach((row, index) => rowById.set(row.id, { row, index }));

  const conflicts = [];
  for (const dev of devices ?? []) {
    const occ = [];
    for (const itemId of dev.itemIds ?? []) {
      const hit = rowById.get(itemId);
      if (hit) occ.push({ itemId, ...hit });
    }
    occ.sort((x, y) => (x.index - y.index) || (x.itemId > y.itemId ? 1 : x.itemId < y.itemId ? -1 : 0));

    for (let i = 1; i < occ.length; i++) {
      const prev = occ[i - 1];
      const cur = occ[i];
      const gapMs = cur.row.projStartMs - prev.row.projEndMs;
      if (gapMs >= dev.turnoverMs) continue;
      conflicts.push({
        key: `${dev.id}:${prev.itemId}>${cur.itemId}`,
        deviceId: dev.id,
        deviceName: dev.name,
        turnoverMs: dev.turnoverMs,
        a: {
          itemId: prev.itemId,
          itemName: prev.row.name,
          itemIndex: prev.index,
          projStartMs: prev.row.projStartMs,
          projEndMs: prev.row.projEndMs,
        },
        b: {
          itemId: cur.itemId,
          itemName: cur.row.name,
          itemIndex: cur.index,
          projStartMs: cur.row.projStartMs,
          projEndMs: cur.row.projEndMs,
        },
        gapMs,
        shortfallMs: dev.turnoverMs - gapMs,
        earliestMs: prev.row.projStartMs,
        _order: `${dev.name} ${dev.id} ${prev.index}`,
      });
    }
  }

  conflicts.sort((x, y) => (x.earliestMs - y.earliestMs)
    || (x._order > y._order ? 1 : x._order < y._order ? -1 : 0));
  return conflicts;
}
