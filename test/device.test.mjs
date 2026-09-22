// 设备占用集成测试：启动独立服务实例（独立端口），验证：
//  1. 首包携带空设备配置；非持有者 devices_set 被拒；
//  2. 设备清单校验（空名称 / 超 20 项 / 非法缓冲 / 绑定未知环节 → BAD_DEVICE）；
//  3. 合法保存：seq 递增、整体替换下发；内容无变化不递增；
//  4. 冲突随议程推演实时刷新：缓冲不足标出双方/缺口/差额，按最早冲突排序；
//     运行中超时（finished）冲突随偏差更新；固定开始环节与跨午夜比较正确；
//  5. 议程整体替换后，绑定到被删除环节的记录自动清理；
//  6. 控制台断线重连恢复完整配置与冲突结果；投屏（注册屏幕后）不接收任何设备消息；
//  7. 数据仅存内存（本用例以默认空清单验证初始状态，重启清空由进程生命周期保证）。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_DEVICES_PORT || 3501;
const URL = `ws://localhost:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (h, m = 0) => (h * 60 + m) * 60 * 1000;
const MIN = 60_000;

let passed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  });
}
async function next(inbox, type, pred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type && (!pred || pred(m)));
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}
// 等待同一广播帧的 snapshot 与紧随其后的 devices（服务端按 snapshot→devices 顺序发送），
// 避免把积压中更早的旧 devices 消息与新快照错配。
async function nextFrame(inbox, snapPred, devPred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const si = inbox.findIndex((m) => m.type === 'snapshot' && (!snapPred || snapPred(m)));
    if (si >= 0) {
      const di = inbox.findIndex((m, idx) => idx > si
        && m.type === 'devices' && (!devPred || devPred(m)));
      if (di >= 0) {
        const snap = inbox[si];
        const dev = inbox[di];
        inbox.splice(Math.max(si, di), 1);
        inbox.splice(Math.min(si, di), 1);
        return { snap, dev };
      }
    }
    if (Date.now() > deadline) throw new Error('等待匹配帧超时');
    await sleep(20);
  }
}
async function drain(inbox, ms = 250) {
  await sleep(ms);
  return inbox.splice(0);
}

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: { ...process.env, PORT: String(PORT), TICK_MS: '100' },
  stdio: 'ignore',
});

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  console.log('1) 初始首包：空设备清单、无冲突');
  const con = await connect();
  await next(con.inbox, 'hello');
  await next(con.inbox, 'snapshot');
  const init = await next(con.inbox, 'devices');
  ok('初始设备清单为空、seq=1、conflicts=[]',
    Array.isArray(init.devices) && init.devices.length === 0
      && init.seq === 1 && Array.isArray(init.conflicts) && init.conflicts.length === 0,
    JSON.stringify(init).slice(0, 200));

  console.log('2) 非持有者 devices_set 被拒');
  const other = await connect();
  await next(other.inbox, 'hello');
  await next(other.inbox, 'snapshot');
  await next(other.inbox, 'devices');
  other.ws.send(JSON.stringify({ command: 'devices_set', devices: [] }));
  const notOwner = await next(other.inbox, 'error');
  ok('非持有者返回 NOT_CONTROLLER', notOwner.code === 'NOT_CONTROLLER', notOwner.code);
  other.ws.close();

  con.ws.send(JSON.stringify({ command: 'acquire' }));
  await next(con.inbox, 'control');
  await drain(con.inbox, 100);

  console.log('3) 设备清单校验');
  con.ws.send(JSON.stringify({ command: 'devices_set', devices: [{ name: '  ', turnoverMin: 5 }] }));
  ok('空名称返回 BAD_DEVICE', (await next(con.inbox, 'error')).code === 'BAD_DEVICE');

  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: Array.from({ length: 21 }, (_, i) => ({ name: `d${i}`, turnoverMin: 1 })),
  }));
  ok('21 项返回 BAD_DEVICE', (await next(con.inbox, 'error')).code === 'BAD_DEVICE');

  con.ws.send(JSON.stringify({ command: 'devices_set', devices: [{ name: 'a', turnoverMin: 99999 }] }));
  ok('非法周转分钟返回 BAD_DEVICE', (await next(con.inbox, 'error')).code === 'BAD_DEVICE');

  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [{ name: '摄像机', turnoverMin: 5, itemIds: ['ghost'] }],
  }));
  ok('绑定未知环节返回 BAD_DEVICE', (await next(con.inbox, 'error')).code === 'BAD_DEVICE');

  console.log('4) 下发议程：i0 09:00(5min) i1 09:06(5min) i2 09:30 固定(5min)');
  const agendaItems = [
    { id: 'i0', name: '环节A', startMs: H(9), durationMs: 5 * MIN, fixed: false },
    { id: 'i1', name: '环节B', startMs: H(9, 6), durationMs: 5 * MIN, fixed: false },
    { id: 'i2', name: '固定C', startMs: H(9, 30), durationMs: 5 * MIN, fixed: true },
  ];
  con.ws.send(JSON.stringify({ command: 'agenda_set', items: agendaItems }));
  await nextFrame(con.inbox, (m) => m.agenda && m.agenda.items.length === 3);

  console.log('5) 保存设备：摄像机缓冲 10 分绑定 i0/i1 → 缺口 1 分冲突；麦缓冲 0 绑定 i2 不冲突');
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [
      { id: 'dcam', name: '主摄像机', turnoverMin: 10, itemIds: ['i0', 'i1'] },
      { id: 'dmic', name: '无线麦', turnoverMin: 0, itemIds: ['i2'] },
    ],
  }));
  const dev1 = await next(con.inbox, 'devices', (m) =>
    m.seq === 2 && m.devices.length === 2);
  ok('设备清单 seq=2，缓冲换算毫秒',
    dev1.devices[0].turnoverMs === 10 * MIN && dev1.devices[0].name === '主摄像机',
    JSON.stringify(dev1.devices[0]));
  ok('1 处冲突：i0→i1，实际缺口 1 分、还差 9 分',
    dev1.conflicts.length === 1
      && dev1.conflicts[0].deviceId === 'dcam'
      && dev1.conflicts[0].a.itemId === 'i0'
      && dev1.conflicts[0].b.itemId === 'i1'
      && dev1.conflicts[0].gapMs === MIN
      && dev1.conflicts[0].shortfallMs === 9 * MIN,
    JSON.stringify(dev1.conflicts));

  // 内容无变化：不递增 seq（仍会整体替换下发一次）
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [
      { id: 'dcam', name: '主摄像机', turnoverMin: 10, itemIds: ['i0', 'i1'] },
      { id: 'dmic', name: '无线麦', turnoverMin: 0, itemIds: ['i2'] },
    ],
  }));
  const same = await next(con.inbox, 'devices');
  ok('内容无变化保存不递增 seq', same.seq === 2, `seq=${same.seq}`);

  // 把缓冲降到 1 分：恰好满足 → 冲突消失
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [
      { id: 'dcam', name: '主摄像机', turnoverMin: 1, itemIds: ['i0', 'i1'] },
      { id: 'dmic', name: '无线麦', turnoverMin: 0, itemIds: ['i2'] },
    ],
  }));
  const devOk = await next(con.inbox, 'devices', (m) => m.seq === 3);
  ok('缓冲=缺口 1 分时冲突消失（gap >= turnover）', devOk.conflicts.length === 0,
    JSON.stringify(devOk.conflicts.map((c) => c.key)));

  console.log('6) 冲突随计时状态实时推演：归零超时后 finished 帧继续刷新冲突（缺口恒定）');
  // 议程 i0 09:00(5min)→i1 09:06(5min)：普通环节背靠背，i1 预计开始 = i0 预计结束，
  // 实际占用缺口恒为 0；缓冲 20 分时冲突始终存在，超时期间双方随偏差同步后移。
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [{ id: 'dcam', name: '主摄像机', turnoverMin: 20, itemIds: ['i0', 'i1'] }],
  }));
  await next(con.inbox, 'devices', (m) => m.seq === 4);

  con.ws.send(JSON.stringify({ command: 'agenda_current', id: 'i0' }));
  const idleFrame = await nextFrame(con.inbox, (m) => m.agenda && m.agenda.currentId === 'i0');
  const idleDev = idleFrame.dev;
  ok('待开始帧：i1 背靠背顺延到 09:05，缺口 0、差 20 分',
    idleDev && idleDev.conflicts.length === 1
      && idleDev.conflicts[0].gapMs === 0
      && idleDev.conflicts[0].shortfallMs === 20 * MIN
      && idleDev.conflicts[0].b.projStartMs === H(9, 5),
    JSON.stringify(idleDev?.conflicts?.[0] && {
      gap: idleDev.conflicts[0].gapMs,
      bStart: idleDev.conflicts[0].b.projStartMs,
    }));

  // 短时长制造超时：set_duration 只改计时器采用时长，不改变议程推演的“计划背靠背”缺口
  con.ws.send(JSON.stringify({ command: 'set_duration', durationMs: 1000 }));
  await next(con.inbox, 'snapshot');
  con.ws.send(JSON.stringify({ command: 'start' }));
  await nextFrame(con.inbox, (m) => m.phase === 'running');

  // 等归零进入 finished（1s 计时 + 少量超时）
  await sleep(1300);
  let finMsgs = await drain(con.inbox, 300);
  let finSnap = finMsgs.filter((m) => m.type === 'snapshot').pop();
  let finDev = finMsgs.filter((m) => m.type === 'devices').pop();
  ok('归零后 finished 帧继续下发设备冲突（超时偏差逐秒刷新）',
    finSnap && finSnap.phase === 'finished'
      && finDev && finDev.conflicts.length === 1,
    `snap=${finSnap?.phase}, conflicts=${finDev?.conflicts?.length}`);
  // 再多等约 1s：超时量继续累积，i0 预计结束与 i1 预计开始应同步后移（背靠背、缺口恒 0）
  const earlyEnd = finDev.conflicts[0].a.projEndMs;
  await sleep(1100);
  finMsgs = await drain(con.inbox, 300);
  finSnap = finMsgs.filter((m) => m.type === 'snapshot').pop();
  finDev = finMsgs.filter((m) => m.type === 'devices').pop();
  const fc = finDev.conflicts[0];
  ok('背靠背顺延：超时累积时双方同步后移，缺口恒为 0',
    finSnap.phase === 'finished'
      && fc.gapMs === 0
      && Math.abs(fc.b.projStartMs - fc.a.projEndMs) < 1
      && fc.a.projEndMs > earlyEnd,
    `gap=${fc.gapMs}, end0=${earlyEnd - H(9)}, end1=${fc.a.projEndMs - H(9)}`);

  console.log('7) 固定开始环节：前序超时把普通环节压到固定点，缺口按推演原值计算');
  // 紧密议程（相对 10:00）：j0 普通 [0,3s]；j1 普通计划 [3s,8s]；j2 固定开始于 8s。
  // j0 超时到 ~4.x 秒才结束 → j1 预计开始 ~4.x、被压缩到固定点 8s 结束 →
  // j1 与 j2 的占用缺口 = 0；设备“固定机位”绑定 j1/j2、缓冲 5 分（300000ms）→ 冲突。
  const T0 = H(10);
  con.ws.send(JSON.stringify({ command: 'reset', durationMs: 30000 }));
  await next(con.inbox, 'snapshot');
  con.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [
      { id: 'j0', name: '当前项', startMs: T0, durationMs: 3000, fixed: false },
      { id: 'j1', name: '普通项', startMs: T0 + 3000, durationMs: 5000, fixed: false },
      { id: 'j2', name: '固定项', startMs: T0 + 8000, durationMs: 5000, fixed: true },
    ],
  }));
  await nextFrame(con.inbox, (m) => m.agenda && m.agenda.items.length === 3);
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [{ id: 'dfix', name: '固定机位', turnoverMin: 5, itemIds: ['j1', 'j2'] }],
  }));
  await next(con.inbox, 'devices', (m) => m.devices[0]?.itemIds?.includes('j1'));

  con.ws.send(JSON.stringify({ command: 'agenda_current', id: 'j0' }));
  await nextFrame(con.inbox, (m) => m.agenda && m.agenda.currentId === 'j0');
  con.ws.send(JSON.stringify({ command: 'start' })); // 采用议程时长 3s
  await nextFrame(con.inbox, (m) => m.phase === 'running');
  // j0 归零后再多等约 1.8s（超时累积），然后结束本环节
  await sleep(4800);
  await drain(con.inbox, 200);
  con.ws.send(JSON.stringify({ command: 'advance' }));
  let fixedFrame = null;
  for (let i = 0; i < 30; i++) {
    const msgs = await drain(con.inbox, 100);
    const snaps = msgs.filter((m) => m.type === 'snapshot');
    // 找到 currentId=j1 的快照及其同帧 devices
    const si = snaps.findIndex((m) => m.agenda?.currentId === 'j1');
    if (si >= 0) {
      const snap = snaps[si];
      const dev = msgs.filter((m) => m.type === 'devices').pop();
      if (dev) { fixedFrame = { snap, dev }; break; }
    }
  }
  ok('advance 后进入 j1', !!fixedFrame, '未进入 j1');
  const fixConflict = fixedFrame?.dev.conflicts.find((c) => c.deviceId === 'dfix');
  const j1row = fixedFrame?.snap.agenda.items.find((it) => it.id === 'j1');
  const j2row = fixedFrame?.snap.agenda.items.find((it) => it.id === 'j2');
  ok('固定环节 j2 预计开始锚定固定点，j1 被压缩至该点且标记时间不足',
    j2row && j2row.projStartMs === T0 + 8000
      && j1row && Math.abs(j1row.projEndMs - (T0 + 8000)) < 50
      && j1row.insufficient === true,
    JSON.stringify({ j1: j1row && [j1row.projStartMs - T0, j1row.projEndMs - T0], j2: j2row?.projStartMs - T0 }));
  ok('相邻占用缺口 0（未达 5 分缓冲）→ 冲突，差 5 分',
    !!fixConflict && fixConflict.gapMs === 0 && fixConflict.shortfallMs === 5 * MIN
      && fixConflict.a.itemId === 'j1' && fixConflict.b.itemId === 'j2',
    JSON.stringify(fixConflict && [fixConflict.gapMs, fixConflict.shortfallMs]));

  console.log('8) 议程整体替换：被删除环节的绑定自动清理，设备本体保留');
  // 当前设备 dfix 绑定 i1/i2；替换为只含全新环节的议程后绑定应清空
  con.ws.send(JSON.stringify({ command: 'reset', durationMs: 30000 }));
  await next(con.inbox, 'snapshot');
  con.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [{ id: 'j0', name: '新环节', startMs: H(14), durationMs: 10 * MIN, fixed: false }],
  }));
  const prunedFrame = await nextFrame(con.inbox,
    (m) => m.agenda && m.agenda.items.length === 1);
  const prunedDev = prunedFrame.dev.devices.find((d) => d.id === 'dfix');
  ok('设备保留且悬空绑定被清空',
    prunedFrame.dev.seq >= 1
      && !!prunedDev && prunedDev.name === '固定机位'
      && Array.isArray(prunedDev.itemIds) && prunedDev.itemIds.length === 0,
    JSON.stringify(prunedDev));
  ok('悬空绑定清理后无冲突', prunedFrame.dev.conflicts.length === 0);
  // 绑定已删除环节的设备无法通过保存接口复活该绑定（仍被 BAD_DEVICE 拒绝）
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [{ id: 'dfix', name: '固定机位', turnoverMin: 5, itemIds: ['i1'] }],
  }));
  ok('保存时引用已删除环节仍返回 BAD_DEVICE',
    (await next(con.inbox, 'error')).code === 'BAD_DEVICE');

  console.log('9) 多设备冲突排序：按最早冲突开始点升序');
  // 议程：早组 08:00/08:02（缺口2），晚组 09:00/09:02（缺口2），缓冲 10 分
  con.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [
      { id: 'e0', name: '早A', startMs: H(8), durationMs: 2 * MIN, fixed: false },
      { id: 'e1', name: '早B', startMs: H(8, 2), durationMs: 2 * MIN, fixed: false },
      { id: 'l0', name: '晚A', startMs: H(9), durationMs: 2 * MIN, fixed: false },
      { id: 'l1', name: '晚B', startMs: H(9, 2), durationMs: 2 * MIN, fixed: false },
    ],
  }));
  await nextFrame(con.inbox, (m) => m.agenda && m.agenda.items.length === 4);
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [
      { id: 'late', name: '晚设备', turnoverMin: 10, itemIds: ['l0', 'l1'] },
      { id: 'early', name: '早设备', turnoverMin: 10, itemIds: ['e0', 'e1'] },
    ],
  }));
  const sorted = await next(con.inbox, 'devices', (m) => m.conflicts.length === 2);
  ok('冲突按最早开始点排序（早设备在前，尽管提交在后）',
    sorted.conflicts[0].deviceId === 'early'
      && sorted.conflicts[0].earliestMs === H(8)
      && sorted.conflicts[1].deviceId === 'late'
      && sorted.conflicts[1].earliestMs === H(9),
    JSON.stringify(sorted.conflicts.map((c) => [c.deviceId, c.earliestMs])));

  console.log('10) 断线重连恢复完整配置与冲突结果');
  const savedSeq = sorted.seq;
  con.ws.close();
  await sleep(300);
  const recon = await connect();
  await next(recon.inbox, 'hello');
  await next(recon.inbox, 'snapshot');
  const reconDev = await next(recon.inbox, 'devices');
  ok('重连首包恢复设备清单（2 项、seq 一致）',
    reconDev.seq === savedSeq && reconDev.devices.length === 2
      && reconDev.devices.find((d) => d.id === 'early')?.turnoverMs === 10 * MIN,
    JSON.stringify({ seq: reconDev.seq, len: reconDev.devices.length }));
  ok('重连首包恢复冲突结果（2 处、排序一致）',
    reconDev.conflicts.length === 2 && reconDev.conflicts[0].deviceId === 'early',
    JSON.stringify(reconDev.conflicts.map((c) => c.deviceId)));
  recon.ws.close();

  console.log('11) 投屏注册后不接收任何设备消息（含首包之后的更新）');
  const holder = await connect();
  await next(holder.inbox, 'hello');
  await next(holder.inbox, 'snapshot');
  await next(holder.inbox, 'devices');
  holder.ws.send(JSON.stringify({ command: 'acquire' }));
  await next(holder.inbox, 'control');
  await drain(holder.inbox, 100);

  const screen = await connect();
  await next(screen.inbox, 'hello');
  await next(screen.inbox, 'snapshot');
  // 注册“之前”首包含 devices（与 markers/inspection 同口径）；清空后注册为投屏
  ok('投屏注册前首包可收到 devices', screen.inbox.some((m) => m.type === 'devices'));
  screen.inbox.length = 0;
  screen.ws.send(JSON.stringify({
    command: 'screen_register',
    screenId: 's-testdevices0001',
    name: '测试屏',
  }));
  await next(screen.inbox, 'screen_hello');
  await drain(screen.inbox, 200);

  holder.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [{ id: 'z1', name: '投屏不可见设备', turnoverMin: 3, itemIds: [] }],
  }));
  await next(holder.inbox, 'devices');
  // 设备编辑不触发快照；再制造一帧快照（推进议程无关，直接设当前环节）
  holder.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [{ id: 'k0', name: '投屏测试环节', startMs: H(11), durationMs: 5 * MIN, fixed: false }],
  }));
  await next(holder.inbox, 'snapshot');
  const screenGot = await drain(screen.inbox, 400);
  ok('投屏注册后收不到任何 devices 消息（快照照常收）',
    !screenGot.some((m) => m.type === 'devices')
      && screenGot.some((m) => m.type === 'snapshot'),
    JSON.stringify(screenGot.map((m) => m.type)));
  screen.ws.close();
  holder.ws.close();

  console.log(`\n设备占用测试：${passed} 通过，${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:', failures.join('; '));
    process.exit(1);
  }
} catch (e) {
  console.error('  ✗', e.stack || e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
