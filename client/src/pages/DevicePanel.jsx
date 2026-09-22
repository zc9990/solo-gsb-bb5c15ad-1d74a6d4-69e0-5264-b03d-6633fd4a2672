import { useEffect, useRef, useState } from 'react';
import { formatClock } from '../time.js';
import { computeDeviceConflicts } from '../deviceConflicts.js';

const MAX_DEVICES = 20;
const MAX_NAME_LEN = 30;
const MAX_TURNOVER_MIN = 24 * 60;

// 缺口/超欠分钟数展示：整数分钟按“分”，非整数保留一位小数
function formatMinutes(ms) {
  const min = ms / 60000;
  const text = Math.abs(min - Math.round(min)) < 0.05 ? String(Math.round(min)) : min.toFixed(1);
  return text;
}

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? `d-${crypto.randomUUID()}`
    : `d-${Math.random().toString(36).slice(2, 10)}`;
}

// 控制台“设备占用”面板：
//  - 持有者维护最多 20 项共享设备（名称 / 周转缓冲分钟），勾选其占用的议程环节（绑定）；
//  - 每次议程、当前环节或计时状态变化后，服务端按权威推演给出各环节预计起止与冲突；
//  - 客户端在两份快照之间对“超时（finished）”外推做与议程面板同口径的本地平滑，
//    冲突双方实时高亮；冲突按最早冲突排序；投屏不接收任何设备数据。
export default function DevicePanel({ devices, snap, liveAgendaRows, canEdit, send, lastError, onClearError }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState([]);            // 草稿：{ id, name, turnoverMin, itemIds }
  const [formError, setFormError] = useState('');
  const [savedSeq, setSavedSeq] = useState(0);
  const hydratedRef = useRef(false);

  const devList = devices?.devices ?? [];
  const agendaItems = liveAgendaRows ?? snap?.agenda?.items ?? [];

  // 权威设备配置回填（首次加载 / 服务端 seq 变化 / 退出编辑态时）
  useEffect(() => {
    if (!devices) return;
    if (!hydratedRef.current || devices.seq !== savedSeq) {
      hydratedRef.current = true;
      setSavedSeq(devices.seq);
      if (!editing) {
        setRows(devices.devices.map((d) => ({
          id: d.id,
          name: d.name,
          turnoverMin: d.turnoverMs / 60000,
          itemIds: [...d.itemIds],
        })));
      }
    }
  }, [devices, savedSeq, editing]);

  useEffect(() => {
    if (!lastError || lastError.code !== 'BAD_DEVICE') return undefined;
    const t = setTimeout(onClearError, 5000);
    return () => clearTimeout(t);
  }, [lastError, onClearError]);

  if (!devices) {
    return (
      <fieldset className="panel" disabled>
        <legend>设备占用</legend>
        <p className="hint">正在加载设备占用状态…</p>
      </fieldset>
    );
  }

  // 冲突以“当前帧推演行”本地现算（finished 超时期间 100ms 平滑外推），与服务端同口径；
  // 权威列表随每帧快照后的 devices 消息刷新，仅在尚无议程行（加载瞬间）时兜底。
  const haveRows = agendaItems.length > 0;
  const liveConflicts = computeDeviceConflicts(devList, agendaItems);
  const conflicts = haveRows ? liveConflicts : (devices.conflicts ?? []);

  // 冲突涉及的（设备 id, 环节 id）集合：用于在设备卡片上实时标红冲突双方
  const hot = new Set();
  for (const c of conflicts) {
    hot.add(`${c.deviceId}|${c.a.itemId}`);
    hot.add(`${c.deviceId}|${c.b.itemId}`);
  }

  const itemById = new Map(agendaItems.map((it) => [it.id, it]));
  // 被悬空清理前的兜底：议程已删除但设备消息尚未刷新时不渲染该绑定
  const validBindings = (ids) => ids.filter((id) => itemById.has(id));

  const startEdit = () => {
    setRows(devList.map((d) => ({
      id: d.id,
      name: d.name,
      turnoverMin: d.turnoverMs / 60000,
      itemIds: [...d.itemIds],
    })));
    setFormError('');
    setEditing(true);
  };

  const updateRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeRow = (i) => setRows((rs) => rs.filter((_, j) => j !== i));
  const addRow = () => setRows((rs) => {
    if (rs.length >= MAX_DEVICES) return rs;
    return [...rs, { id: newId(), name: '', turnoverMin: 10, itemIds: [] }];
  });
  const toggleBinding = (i, itemId) => setRows((rs) => rs.map((r, j) => {
    if (j !== i) return r;
    const has = r.itemIds.includes(itemId);
    // 绑定顺序按议程顺序保存，保证“相邻占用”与议程次序一致
    const next = has ? r.itemIds.filter((x) => x !== itemId) : [...r.itemIds, itemId];
    next.sort((x, y) => {
      const ix = agendaItems.findIndex((it) => it.id === x);
      const iy = agendaItems.findIndex((it) => it.id === y);
      return ix - iy;
    });
    return { ...r, itemIds: next };
  }));

  const save = () => {
    if (rows.length > MAX_DEVICES) {
      setFormError(`共享设备最多 ${MAX_DEVICES} 项`);
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].name.trim()) {
        setFormError(`第 ${i + 1} 项设备名称不能为空`);
        return;
      }
      const t = Number(rows[i].turnoverMin);
      if (!Number.isFinite(t) || t < 0 || t > MAX_TURNOVER_MIN) {
        setFormError(`第 ${i + 1} 项周转缓冲需为 0~${MAX_TURNOVER_MIN} 分钟`);
        return;
      }
    }
    setFormError('');
    send({
      command: 'devices_set',
      devices: rows.map((r) => ({
        id: r.id,
        name: r.name.trim().slice(0, MAX_NAME_LEN),
        turnoverMin: Number(r.turnoverMin) || 0,
        itemIds: r.itemIds,
      })),
    });
    setSavedSeq(devices.seq); // seq 由服务端权威回执刷新；保存期间避免草稿被旧快照回填
    setEditing(false);
  };

  return (
    <fieldset className="panel devices-panel" disabled={!canEdit}>
      <legend>
        设备占用（共享设备周转缓冲：同一设备相邻占用间隔不足时实时标出冲突；最多 {MAX_DEVICES} 项）
      </legend>

      {/* ---- 冲突摘要：按最早冲突排序 ---- */}
      {conflicts.length > 0 && (
        <div className="dev-conflict-list">
          <div className="dev-conflict-head">
            ⚠ {conflicts.length} 处周转冲突（按最早冲突排序）
          </div>
          {conflicts.map((c) => (
            <div className="dev-conflict" key={c.key}>
              <span className="dev-conflict-name">{c.deviceName}</span>
              <span className="dev-conflict-pair">
                「{c.a.itemName}」
                <em className="dev-conflict-time">{formatClock(c.a.projStartMs)}–{formatClock(c.a.projEndMs)}</em>
                {' '}→{' '}
                「{c.b.itemName}」
                <em className="dev-conflict-time">{formatClock(c.b.projStartMs)}–{formatClock(c.b.projEndMs)}</em>
              </span>
              <span className="dev-conflict-gap">
                {c.gapMs < 0
                  ? <>占用重叠 <b>{formatMinutes(-c.gapMs)} 分</b></>
                  : <>实际缺口仅 <b>{formatMinutes(c.gapMs)} 分</b></>}
                ，要求 {formatMinutes(c.turnoverMs)} 分，还差 <b>{formatMinutes(c.shortfallMs)} 分</b>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="insp-summary">
        <span className="insp-count">设备 {devList.length}/{MAX_DEVICES}</span>
        <span className={`insp-count ${conflicts.length ? 'insp-fault' : 'insp-pass'}`}>
          冲突 {conflicts.length}
        </span>
        {!editing && (
          <button type="button" className="btn btn-mini insp-edit-btn" onClick={startEdit}>
            ✎ 维护设备
          </button>
        )}
      </div>

      {editing ? (
        <>
          <div className="dev-edit-table" role="table">
            <div className="insp-row insp-head" role="row">
              <span>#</span>
              <span>设备名称</span>
              <span>周转缓冲(分)</span>
              <span>占用环节（勾选绑定）</span>
              <span>操作</span>
            </div>
            {rows.map((r, i) => (
              <div className="insp-row dev-edit-row" role="row" key={r.id}>
                <span className="insp-idx">{i + 1}</span>
                <span>
                  <input
                    value={r.name}
                    maxLength={MAX_NAME_LEN}
                    placeholder={`设备 ${i + 1}，如：主摄像机`}
                    onChange={(e) => updateRow(i, { name: e.target.value.slice(0, MAX_NAME_LEN) })}
                  />
                </span>
                <span>
                  <input
                    className="dev-turn-input"
                    type="number"
                    min="0"
                    max={MAX_TURNOVER_MIN}
                    step="1"
                    value={r.turnoverMin}
                    onChange={(e) => updateRow(i, { turnoverMin: e.target.value })}
                  />
                </span>
                <span className="dev-bind-cell">
                  {agendaItems.length === 0 && <em className="hint">议程为空</em>}
                  {agendaItems.map((it) => (
                    <label key={it.id} className="dev-bind-chip" title={`${formatClock(it.projStartMs)} 开始`}>
                      <input
                        type="checkbox"
                        checked={r.itemIds.includes(it.id)}
                        onChange={() => toggleBinding(i, it.id)}
                      />
                      {it.name}
                      {it.fixed && ' 📌'}
                    </label>
                  ))}
                </span>
                <span className="insp-ops">
                  <button type="button" className="btn btn-mini btn-danger" onClick={() => removeRow(i)}>删</button>
                </span>
              </div>
            ))}
            {rows.length === 0 && <p className="hint">尚未配置共享设备。</p>}
          </div>
          <div className="insp-actions">
            <button type="button" className="btn" onClick={addRow} disabled={rows.length >= MAX_DEVICES}>
              ＋ 添加设备（{rows.length}/{MAX_DEVICES}）
            </button>
            <button type="button" className="btn btn-primary" onClick={save}>保存设备清单</button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { setEditing(false); setFormError(''); }}
            >
              取消
            </button>
          </div>
          <p className="hint hint-warn">
            绑定到议程环节后，服务端按权威推演的预计起止区间实时比对；议程中删除的环节会自动从绑定中清理。
          </p>
          {formError && <p className="agenda-error">⚠ {formError}</p>}
          {lastError?.code === 'BAD_DEVICE' && <p className="agenda-error">⚠ {lastError.message}</p>}
        </>
      ) : (
        /* ---- 只读占用视图：每台设备按议程顺序列出占用区间，冲突双方标红 ---- */
        <div className="dev-cards">
          {devList.length === 0 && (
            <p className="hint">
              尚未配置共享设备。点“维护设备”添加（如：主摄像机、无线麦、同传耳机），
              设置周转缓冲分钟并勾选占用该设备的议程环节；间隔不足时会在此实时标出冲突。
            </p>
          )}
          {devList.map((d, di) => {
            const ids = validBindings(d.itemIds)
              .map((id) => ({ id, row: itemById.get(id) }))
              .sort((x, y) => agendaItems.indexOf(x.row) - agendaItems.indexOf(y.row));
            return (
              <div className="dev-card" key={d.id}>
                <div className="dev-card-head">
                  <span className="dev-card-name">{di + 1}. {d.name}</span>
                  <span className="dev-card-turn">周转缓冲 {formatMinutes(d.turnoverMs)} 分</span>
                </div>
                {ids.length === 0 ? (
                  <p className="hint">未绑定议程环节</p>
                ) : (
                  <div className="dev-occ-list">
                    {ids.map(({ id, row }) => (
                      <span
                        key={id}
                        className={`dev-occ ${hot.has(`${d.id}|${id}`) ? 'dev-occ-hot' : ''}`}
                        title={row.fixed ? '固定开始环节' : ''}
                      >
                        <em className="dev-occ-name">{row.name}{row.fixed && ' 📌'}</em>
                        <em className="dev-occ-time">
                          {formatClock(row.projStartMs)}–{formatClock(row.projEndMs)}
                        </em>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="hint">
        预计区间与冲突由服务端按同一帧权威议程推演计算（固定开始环节锚定计划点、跨午夜按推演原值比较）；
        超时期间客户端在两帧快照间平滑外推。配置仅存服务端内存，服务 / 容器重启即清空；投屏不显示设备数据。
      </p>
    </fieldset>
  );
}
