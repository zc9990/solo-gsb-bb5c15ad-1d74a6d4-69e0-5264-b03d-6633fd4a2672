// 设备占用纯函数单测：node test/devices.test.mjs
import assert from 'node:assert/strict';
import {
  normalizeDevices,
  setDevices,
  pruneDeviceBindings,
  computeDeviceConflicts,
  defaultDevices,
  MAX_DEVICES,
  MAX_TURNOVER_MIN,
} from '../server/src/devices.js';

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

const H = (h, m = 0) => (h * 60 + m) * 60 * 1000;
const MIN = 60_000;

// 议程推演行（与 projectAgenda 输出同构）
const row = (id, name, startH, startM, durMin, extra = {}) => ({
  id,
  name,
  startMs: H(startH, startM),
  durationMs: durMin * MIN,
  projStartMs: extra.projStartH != null
    ? H(extra.projStartH, extra.projStartM ?? 0)
    : H(startH, startM),
  projEndMs: extra.projEndH != null
    ? H(extra.projEndH, extra.projEndM ?? 0)
    : H(startH, startM) + durMin * MIN,
});

check('normalizeDevices 校验：非数组 / 空名称 / 超 20 项 / 非法周转分钟', () => {
  assert.equal(normalizeDevices(null, new Set()).error, 'BAD_DEVICE');
  assert.equal(normalizeDevices([{ name: '  ', turnoverMin: 5 }], new Set()).error, 'BAD_DEVICE');
  const tooMany = Array.from({ length: MAX_DEVICES + 1 }, (_, i) => ({
    name: `d${i}`, turnoverMin: 1,
  }));
  assert.equal(normalizeDevices(tooMany, new Set()).error, 'BAD_DEVICE');
  assert.equal(normalizeDevices([{ name: 'a', turnoverMin: -1 }], new Set()).error, 'BAD_DEVICE');
  assert.equal(normalizeDevices([{ name: 'a', turnoverMin: MAX_TURNOVER_MIN + 1 }], new Set()).error,
    'BAD_DEVICE');
});

check('normalizeDevices：未知环节绑定拒绝；重复绑定去重；周转分钟换算毫秒', () => {
  const valid = new Set(['i0', 'i1']);
  const bad = normalizeDevices([{ name: '摄像机', turnoverMin: 5, itemIds: ['nope'] }], valid);
  assert.equal(bad.error, 'BAD_DEVICE');

  const ok = normalizeDevices([{
    id: 'd1', name: '摄像机', turnoverMin: 10, itemIds: ['i0', 'i1', 'i0'],
  }], valid);
  assert.ok(ok.devices);
  assert.deepEqual(ok.devices[0].itemIds, ['i0', 'i1']);
  assert.equal(ok.devices[0].turnoverMs, 10 * MIN);
});

check('setDevices：内容无变化为 no-op；变化递增 seq', () => {
  const state = defaultDevices();
  const valid = new Set(['i0']);
  const r1 = setDevices(state, [{ id: 'd1', name: '麦', turnoverMin: 3, itemIds: ['i0'] }], valid);
  assert.equal(r1.changed, true);
  assert.equal(r1.state.seq, 2);
  const state2 = r1.state;
  // 客户端按线上协议回传 turnoverMin（3 分）；内容一致视为 no-op
  const r2 = setDevices(state2, [{ id: 'd1', name: '麦', turnoverMin: 3, itemIds: ['i0'] }], valid);
  assert.equal(r2.changed, false);
  const r3 = setDevices(state2, [{ id: 'd1', name: '麦', turnoverMin: 4, itemIds: ['i0'] }], valid);
  assert.equal(r3.changed, true);
  assert.equal(r3.state.seq, 3);
});

check('pruneDeviceBindings：删除环节后自动清理悬空绑定；设备本体保留', () => {
  const devices = [
    { id: 'd1', name: 'A', turnoverMs: 5 * MIN, itemIds: ['i0', 'gone'] },
    { id: 'd2', name: 'B', turnoverMs: 0, itemIds: ['gone'] },
  ];
  const next = pruneDeviceBindings(devices, new Set(['i0']));
  assert.deepEqual(next[0].itemIds, ['i0']);
  assert.deepEqual(next[1].itemIds, []);
  assert.equal(next[1].name, 'B'); // 设备本体保留
  // 无悬空时原样返回（引用相等）
  const same = pruneDeviceBindings(next, new Set(['i0']));
  assert.equal(same, next);
});

check('computeDeviceConflicts：缺口达到缓冲不冲突；不足时给出双方/缺口/差额并排序', () => {
  // i0 09:00-09:10；i1 09:15-09:20（缺口 5 分）；i2 10:00-10:10
  const rows = [
    { id: 'i0', name: '环节A', projStartMs: H(9), projEndMs: H(9, 10) },
    { id: 'i1', name: '环节B', projStartMs: H(9, 15), projEndMs: H(9, 20) },
    { id: 'i2', name: '环节C', projStartMs: H(10), projEndMs: H(10, 10) },
  ];
  const devices = [
    { id: 'd1', name: '摄像机', turnoverMs: 5 * MIN, itemIds: ['i0', 'i1'] }, // 恰好 5 分：不冲突
    { id: 'd2', name: '麦', turnoverMs: 10 * MIN, itemIds: ['i0', 'i1'] },    // 差 5 分：冲突
  ];
  const c = computeDeviceConflicts(devices, rows);
  assert.equal(c.length, 1);
  assert.equal(c[0].deviceId, 'd2');
  assert.equal(c[0].a.itemId, 'i0');
  assert.equal(c[0].b.itemId, 'i1');
  assert.equal(c[0].gapMs, 5 * MIN);
  assert.equal(c[0].shortfallMs, 5 * MIN);

  // 缓冲为 0 时仅重叠才算冲突
  const c0 = computeDeviceConflicts(
    [{ id: 'd3', name: '灯', turnoverMs: 0, itemIds: ['i0', 'i1'] }], rows);
  assert.equal(c0.length, 0);
});

check('重叠占用：gap 为负，shortfall 含重叠时长', () => {
  const rows = [
    { id: 'i0', name: 'A', projStartMs: H(9), projEndMs: H(9, 12) },
    { id: 'i1', name: 'B', projStartMs: H(9, 10), projEndMs: H(9, 20) },
  ];
  const c = computeDeviceConflicts(
    [{ id: 'd', name: 'X', turnoverMs: 5 * MIN, itemIds: ['i0', 'i1'] }], rows);
  assert.equal(c.length, 1);
  assert.equal(c[0].gapMs, -2 * MIN);
  assert.equal(c[0].shortfallMs, 7 * MIN);
});

check('固定环节与跨午夜：用推演原始毫秒值比较，不做 mod 24h', () => {
  // 普通环节超时顺延越过午夜：23:55-次日 00:05（projEnd = 24:05）；
  // 下一占用 次日 00:10-00:20（projStart = 24:10）。缺口 5 分，缓冲 10 分 → 冲突。
  const rows = [
    { id: 'i0', name: '夜场', projStartMs: H(23, 55), projEndMs: H(24, 5) },
    { id: 'i1', name: '收场', projStartMs: H(24, 10), projEndMs: H(24, 20) },
  ];
  const c = computeDeviceConflicts(
    [{ id: 'd', name: '同传', turnoverMs: 10 * MIN, itemIds: ['i0', 'i1'] }], rows);
  assert.equal(c.length, 1);
  assert.equal(c[0].shortfallMs, 5 * MIN);

  // 固定环节不移动的场景：i0 被压缩到固定点 23:00 结束，i1 固定 23:00 开始 → 缺口 0
  const fixedRows = [
    { id: 'f0', name: '普通', projStartMs: H(22, 50), projEndMs: H(23) },
    { id: 'f1', name: '固定', projStartMs: H(23), projEndMs: H(23, 10) },
  ];
  const c2 = computeDeviceConflicts(
    [{ id: 'd2', name: '麦', turnoverMs: 1 * MIN, itemIds: ['f0', 'f1'] }], fixedRows);
  assert.equal(c2.length, 1);
  assert.equal(c2[0].gapMs, 0);
  assert.equal(c2[0].shortfallMs, MIN);
});

check('同一设备多段占用：仅相邻两两比较；冲突按最早开始点排序', () => {
  const rows = [
    { id: 'i0', name: 'A', projStartMs: H(10), projEndMs: H(10, 5) },
    { id: 'i1', name: 'B', projStartMs: H(10, 6), projEndMs: H(10, 10) },  // 缺口 1
    { id: 'i2', name: 'C', projStartMs: H(10, 30), projEndMs: H(10, 35) }, // 与 i1 缺口 20
  ];
  const devices = [
    { id: 'd', name: '机', turnoverMs: 5 * MIN, itemIds: ['i0', 'i1', 'i2'] },
  ];
  const c = computeDeviceConflicts(devices, rows);
  assert.equal(c.length, 1);
  assert.equal(c[0].a.itemId, 'i0');
  assert.equal(c[0].b.itemId, 'i1');
});

check('多设备冲突按最早冲突（较早占用开始点）升序排序', () => {
  const rows = [
    { id: 'i0', name: 'A', projStartMs: H(9), projEndMs: H(9, 10) },
    { id: 'i1', name: 'B', projStartMs: H(9, 12), projEndMs: H(9, 20) },
    { id: 'i2', name: 'C', projStartMs: H(8), projEndMs: H(8, 10) },
    { id: 'i3', name: 'D', projStartMs: H(8, 11), projEndMs: H(8, 20) },
  ];
  const devices = [
    { id: 'late', name: '晚设备', turnoverMs: 5 * MIN, itemIds: ['i0', 'i1'] },
    { id: 'early', name: '早设备', turnoverMs: 5 * MIN, itemIds: ['i2', 'i3'] },
  ];
  const c = computeDeviceConflicts(devices, rows);
  assert.equal(c.length, 2);
  assert.equal(c[0].deviceId, 'early'); // 08:00 早于 09:00
  assert.equal(c[1].deviceId, 'late');
});

check('绑定乱序提交时按议程序号取相邻占用（而非提交顺序）', () => {
  const rows = [
    { id: 'i0', name: 'A', projStartMs: H(9), projEndMs: H(9, 10) },
    { id: 'i1', name: 'B', projStartMs: H(9, 15), projEndMs: H(9, 20) },
    { id: 'i2', name: 'C', projStartMs: H(9, 30), projEndMs: H(9, 40) },
  ];
  // 议程序号 i0 < i1 < i2；提交顺序故意打乱为 i2, i0, i1。
  // 缓冲 7 分：相邻对 (i0,i1) 缺口 5 差 2 分 → 冲突；(i1,i2) 缺口 10 → 不冲突。
  const c = computeDeviceConflicts(
    [{ id: 'd', name: 'X', turnoverMs: 7 * MIN, itemIds: ['i2', 'i0', 'i1'] }], rows);
  assert.equal(c.length, 1);
  assert.equal(c[0].a.itemId, 'i0');
  assert.equal(c[0].b.itemId, 'i1');
  assert.equal(c[0].gapMs, 5 * MIN);
  assert.equal(c[0].shortfallMs, 2 * MIN);
});

console.log(`\n设备占用单测：${n} 通过，0 失败`);
